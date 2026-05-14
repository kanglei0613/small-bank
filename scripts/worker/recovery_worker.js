'use strict';

/**
 * scripts/worker/recovery_worker.js
 *
 * 獨立 Node.js process，掃描 saga_log 並修復卡住的跨 shard 轉帳。
 *
 * 啟動方式：
 *   node scripts/worker/recovery_worker.js
 *
 * 環境變數：
 *   SAGA_RECOVERY_INTERVAL_MS   每輪掃描間隔（預設 10000）
 *   SAGA_STALE_THRESHOLD_SEC    卡住超過幾秒才處理（預設 30）
 *   SAGA_SCAN_BATCH_SIZE        每輪最多處理幾筆（預設 50）
 *   PG_SHARD_POOL_MAX
 *   PG_META_POOL_MAX
 *
 * ════════════════════════════════════════════════════════════════
 * ⚠️  架構審查標注（Architecture Review Annotations）2026-05-14 v7
 * ════════════════════════════════════════════════════════════════
 *
 * [NOT PRODUCTION-READY] 以下已知問題需在 production 部署前修補：
 * （架構審查 v7 確認，2026-05-14：C1/C2/C3/C4 及所有 HIGH/MEDIUM 問題仍為 open；
 *   v7 無新增問題於此檔案，新增問題 L11/L12 在 redis_transfer_queue.js）
 *
 * 1. 【CRITICAL】recoverFromCredited 可能撤銷已完成的轉帳（Race with queue worker）
 *    詳見 recoverFromCredited 函數內的標注。
 *    核心問題：finalize rowCount=0 時未檢查 transfers.status，直接走補償路徑。
 *    修法：在 rowCount=0 時先查 transfers.status，若為 COMPLETED 則同步 saga_log 並返回。
 *
 * 2. STALE_THRESHOLD=30s 可能過激進（Aggressive stale threshold）
 *    在 queue 積壓情況下，saga 從 CREDITED 到 FINALIZE 可能 > 30s。
 *    recovery_worker 與 queue_worker 競爭 finalize，若 queue_worker 先完成，
 *    recovery_worker 反而執行錯誤補償（見問題 1）。
 *    修法：調高 threshold（60-300s），並在 queue_worker 的 saga_log 更新中加入 heartbeat。
 *
 * 3. INTERVAL 字串插值（Template literal in SQL - not parameterized）
 *    `INTERVAL '${STALE_THRESHOLD} seconds'` 使用模板字串。
 *    雖然 parseInt 保護 STALE_THRESHOLD 為整數，但這是不良模式。
 *    修法：改用 `updated_at < NOW() - ($1 * INTERVAL '1 second')` 參數化查詢。
 *
 * 4. 單一 process、無主備切換（Single process, no HA）
 *    只有一個 recovery_worker instance，crash 後 saga 停止恢復。
 *    修法：可多個 instance 並行（每筆 saga 以 SELECT FOR UPDATE SKIP LOCKED 取得），
 *    或使用 supervisor（PM2/systemd）確保自動重啟。
 *
 * 5. NEEDS_REVIEW 無告警（No alerting for manual intervention required）
 *    NEEDS_REVIEW 狀態的 saga 只寫 error log，無 Prometheus counter、無 PagerDuty alert。
 *    修法：新增 Prometheus counter `saga_needs_review_total`，觸發 > 0 時 alert。
 *
 * 6. 硬碼預設使用者名稱（Hardcoded default PG username）
 *    pgBase.user 預設 'kanglei0613'，production 必須透過 PG_USER 覆蓋。
 *
 * 7. 【v4 新增 — M17】recoverShard 缺少 FOR UPDATE SKIP LOCKED（Multiple recovery instance race）
 *
 * 8. 【v6 新增 — L10】main loop 四個 shard 依序掃描（Sequential shard scan — Risk: LOW）
 *    主迴圈以 `for...of` 依序呼叫 `recoverShard`，shard 0 積壓時，shard 1-3 的 recovery 被延遲。
 *    修法：改用 `Promise.all(shardIds.map(id => recoverShard(id, shardPgMap)))` 並行掃描。
 *    注意：並行時需確認 PG_SHARD_POOL_MAX 足以支撐 SCAN_BATCH_SIZE × 4 的連線需求。
 *    Risk level: LOW — 功能正確，但高負載下 recovery lag 較大。
 *    若部署多個 recovery_worker instance（M5 的修法），recoverShard 不加 FOR UPDATE SKIP LOCKED
 *    會導致多個 instance 選取相同的 saga row：
 *      - Instance A 補償成功（saga_compensations 寫入、saga_log=FAILED）
 *      - Instance B 跳過 toAccount 補償（冪等 ✅），但嘗試補償 fromAccount，
 *        reserved_balance 已為 0 → rowCount=0 → 誤標 NEEDS_REVIEW（❌ 誤報）
 *    修法：在 recoverShard SQL 末尾加入 `FOR UPDATE SKIP LOCKED`，
 *    確保同一 saga 只被一個 instance 處理，詳見 recoverShard 函數標注。
 */

const { Pool } = require('pg');
const { format } = require('util');

// ─── Config ──────────────────────────────────────────────────────────────────

const INTERVAL_MS       = parseInt(process.env.SAGA_RECOVERY_INTERVAL_MS || '10000');
const STALE_THRESHOLD   = parseInt(process.env.SAGA_STALE_THRESHOLD_SEC  || '30');
const SCAN_BATCH_SIZE   = parseInt(process.env.SAGA_SCAN_BATCH_SIZE      || '50');
const PG_META_POOL_MAX  = parseInt(process.env.PG_META_POOL_MAX          || '2');
const PG_SHARD_POOL_MAX = parseInt(process.env.PG_SHARD_POOL_MAX         || '5');
const SHARD_COUNT       = 4;

// ─── Logger ──────────────────────────────────────────────────────────────────

const logger = {
  info:  (msg, ...a) => console.log ('[SagaRecovery]', a.length ? format(msg, ...a) : msg),
  warn:  (msg, ...a) => console.warn ('[SagaRecovery]', a.length ? format(msg, ...a) : msg),
  error: (msg, ...a) => console.error('[SagaRecovery]', a.length ? format(msg, ...a) : msg),
};

// ─── PostgreSQL pools ─────────────────────────────────────────────────────────

const pgBase = {
  // PG_HOST is used for single-host setups (e.g. local dev where all shards
  // are on the same PostgreSQL instance). In Docker / multi-host setups,
  // PG_SHARD_N_HOST overrides this per shard.
  host:                    process.env.PG_HOST     || '127.0.0.1',
  port:                    parseInt(process.env.PG_PORT || '5432'),
  user:                    process.env.PG_USER     || 'kanglei0613',
  password:                process.env.PG_PASSWORD || '',
  idleTimeoutMillis:       30000,
  connectionTimeoutMillis: 5000,
  statement_timeout:       5000,
};

function createShardPgMap() {
  const shardDbs = {
    0: process.env.PG_SHARD_0_DB || 'small_bank_s0',
    1: process.env.PG_SHARD_1_DB || 'small_bank_s1',
    2: process.env.PG_SHARD_2_DB || 'small_bank_s2',
    3: process.env.PG_SHARD_3_DB || 'small_bank_s3',
  };
  const shardHosts = {
    0: process.env.PG_SHARD_0_HOST || pgBase.host,
    1: process.env.PG_SHARD_1_HOST || pgBase.host,
    2: process.env.PG_SHARD_2_HOST || pgBase.host,
    3: process.env.PG_SHARD_3_HOST || pgBase.host,
  };

  const map = {};
  for (const [ id, database ] of Object.entries(shardDbs)) {
    map[id] = new Pool({ ...pgBase, host: shardHosts[id], database, max: PG_SHARD_POOL_MAX });
  }
  return map;
}

// ─── Recovery logic ───────────────────────────────────────────────────────────

// 掃單一 shard 的 saga_log，找出卡住的記錄
//
// ⚠️ [NOT PRODUCTION-READY] 需要在 saga_log 上建立 (step, updated_at) 複合索引：
//   CREATE INDEX CONCURRENTLY ON saga_log (step, updated_at)
//   WHERE step IN ('RESERVED', 'CREDITED', 'COMPENSATING');
//   沒有此 index，每輪掃描做 full table scan，高 saga_log 量下效能嚴重劣化。
//
// ⚠️ [BAD PRACTICE] INTERVAL 字串插值（Template literal - not parameterized query）
//   `INTERVAL '${STALE_THRESHOLD} seconds'` — STALE_THRESHOLD 由 parseInt 保護，
//   但這是不良模式，建議改為：`updated_at < NOW() - ($1 * INTERVAL '1 second')` 並傳入參數。
//
// ⚠️ [NOT PRODUCTION-READY — v4 新增 — M17] 缺少 FOR UPDATE SKIP LOCKED
//   若部署多個 recovery_worker instance，此查詢需改為：
//   ```sql
//   SELECT ... FROM saga_log
//   WHERE step IN (...) AND updated_at < ...
//   ORDER BY updated_at ASC LIMIT $1
//   FOR UPDATE SKIP LOCKED   ← 必須加此行
//   ```
//   缺少 SKIP LOCKED 時，多個 instance 同時處理同一 saga：
//     - Instance A 補償成功（冪等保護 toAccount），但繼續補償 fromAccount 時
//       reserved=0（A 已補過）→ rowCount=0 → NEEDS_REVIEW（誤報）
//   建議在實施 M5（多 instance）修法前，先加入 SKIP LOCKED。
async function recoverShard(fromShardId, shardPgMap) {
  const shardPg = shardPgMap[fromShardId];

  // ⚠️ [v4 — M17] 若需部署多個 recovery_worker instance（M5 修法），
  //   請在 LIMIT $1 後加入 FOR UPDATE SKIP LOCKED，否則多 instance 會同時處理相同的 saga row，
  //   導致補償競爭並產生誤報的 NEEDS_REVIEW（詳見文件頂部問題 7 說明）。
  const result = await shardPg.query(
    `
      SELECT
        id,
        transfer_id      AS "transferId",
        step,
        from_account_id  AS "fromAccountId",
        to_account_id    AS "toAccountId",
        from_shard_id    AS "fromShardId",
        to_shard_id      AS "toShardId",
        amount,
        updated_at       AS "updatedAt"
      FROM saga_log
      WHERE step IN ('RESERVED', 'CREDITED', 'COMPENSATING')
        AND updated_at < NOW() - INTERVAL '${STALE_THRESHOLD} seconds'
      ORDER BY updated_at ASC
      LIMIT $1
      -- TODO [M17]: ADD "FOR UPDATE SKIP LOCKED" HERE when deploying multiple recovery instances
    `,
    [ SCAN_BATCH_SIZE ]
  );

  if (result.rows.length === 0) return;

  logger.info('found %d stale entries on shard %d', result.rows.length, fromShardId);

  for (const row of result.rows) {
    await recoverOne(row, shardPgMap);
  }
}

// 依照 step 狀態決定補償或 finalize
async function recoverOne(log, shardPgMap) {
  logger.info(
    'processing: transferId=%s step=%s fromShard=%d toShard=%d amount=%s',
    log.transferId, log.step, log.fromShardId, log.toShardId, log.amount
  );

  try {
    if (log.step === 'RESERVED') {
      await recoverFromReserved(log, shardPgMap);
    } else if (log.step === 'CREDITED') {
      await recoverFromCredited(log, shardPgMap);
    } else if (log.step === 'COMPENSATING') {
      await recoverFromCompensating(log, shardPgMap);
    }
  } catch (err) {
    logger.error(
      'failed to recover: transferId=%s step=%s err=%s',
      log.transferId, log.step, err && err.message
    );
    // 不 throw，繼續處理下一筆
  }
}

// step = RESERVED：Step 1 commit 了，Step 2 不確定
// 先查 toShard 的 saga_credits 確認 toAccount 是否已入帳
//   有記錄 → Step 2 已完成，走 compensateCredited（反轉兩邊）
//   無記錄 → 查 transfers.status 確認狀態，再決定補償或同步終態
async function recoverFromReserved(log, shardPgMap) {
  const fromShardPg = shardPgMap[log.fromShardId];
  const toShardPg   = shardPgMap[log.toShardId];

  // 先查 toShard 的 saga_credits，確認 toAccount 是否已入帳
  const creditsResult = await toShardPg.query(
    'SELECT id FROM saga_credits WHERE transfer_id = $1 LIMIT 1',
    [ log.transferId ]
  );

  if (creditsResult.rowCount > 0) {
    // ⚠️ [HIGH BUG — 架構審查 2026-05-13 新發現] recoverFromReserved 也存在與 recoverFromCredited 類似的 Race Condition
    //
    // 問題描述（Race condition scenario）：
    //   1. Step 1 commit 成功（saga_log.step = 'RESERVED'），但 job 在 Redis queue 積壓 > 30s。
    //   2. recovery_worker 掃到 step=RESERVED（STALE_THRESHOLD 觸發），開始執行 recoverFromReserved。
    //   3. 在 recovery 讀取 saga_credits 之前，queue_worker 突然開始處理此 job，
    //      完成 Step 2（CREDIT，saga_credits 寫入）+ Step 3（FINALIZE，saga_log.step = 'COMPLETED'）。
    //   4. recovery 讀到 saga_credits 存在（Step 2 已完成），判斷需要補償。
    //   5. recovery 呼叫 compensateCredited：
    //      - 將 saga_log.step 從 'COMPLETED' 改寫為 'COMPENSATING'（錯誤！）
    //      - toAccount 被扣回 amount（已完成的轉帳被撤銷）
    //      - fromAccount reserved_balance 已是 0 → rowCount=0 → NEEDS_REVIEW
    //
    // 根本修法（Required fix）：
    //   在 saga_credits 存在時，先查 transfers.status。
    //   若為 'COMPLETED'，代表 queue_worker 已完成全部步驟，只需同步 saga_log 後返回。
    //
    //   應加入的程式碼（在 compensateCredited 呼叫前）：
    //   ┌─────────────────────────────────────────────────────────────────────
    //   │ const transferRow = await fromShardPg.query(
    //   │   'SELECT status FROM transfers WHERE id = $1',
    //   │   [log.transferId]
    //   │ );
    //   │ if (transferRow.rows[0]?.status === 'COMPLETED') {
    //   │   await fromShardPg.query(
    //   │     'UPDATE saga_log SET step = $1, updated_at = NOW() WHERE transfer_id = $2',
    //   │     ['COMPLETED', log.transferId]
    //   │   );
    //   │   logger.info('transfer already COMPLETED by queue_worker (RESERVED path), synced saga_log: transferId=%s', log.transferId);
    //   │   return; // 正確退出，不走補償
    //   │ }
    //   └─────────────────────────────────────────────────────────────────────
    //
    // 觸發條件：
    //   job 在 queue 積壓 > 30s，queue_worker 在 recovery 執行期間完成 Steps 2+3。
    //   觸發機率低於 recoverFromCredited race（需要步驟 1→2→3 在 recovery 執行窗口內全部完成），
    //   但在高負載、Redis 積壓或 worker 重啟後恢復的場景下仍可能發生。
    //
    // ✅ [C4 FIXED] 先查 transfers.status，確認 queue_worker 是否已完成 Steps 2+3
    const transferRow = await fromShardPg.query(
      'SELECT status FROM transfers WHERE id = $1',
      [ log.transferId ]
    );
    if (transferRow.rows[0]?.status === 'COMPLETED') {
      // queue_worker 已完成全部步驟，只需同步 saga_log 後返回，不走補償
      await fromShardPg.query(
        'UPDATE saga_log SET step = $1, updated_at = NOW() WHERE transfer_id = $2',
        [ 'COMPLETED', log.transferId ]
      );
      logger.info('transfer already COMPLETED by queue_worker (RESERVED path), synced saga_log: transferId=%s', log.transferId);
      return;
    }
    // 確認非 COMPLETED，才走補償路徑
    logger.info(
      'RESERVED but saga_credits exists, toAccount was credited, compensating both: transferId=%s',
      log.transferId
    );
    await compensateCredited(log, shardPgMap);
    return;
  }

  const transferResult = await fromShardPg.query(
    'SELECT status FROM transfers WHERE id = $1',
    [ log.transferId ]
  );

  if (transferResult.rowCount === 0) {
    logger.error('transfer record missing: transferId=%s', log.transferId);
    return;
  }

  const { status } = transferResult.rows[0];

  // 已是終態，只需補上 saga_log 標記
  if (status === 'COMPLETED' || status === 'FAILED') {
    await fromShardPg.query(
      'UPDATE saga_log SET step = $1, updated_at = NOW() WHERE transfer_id = $2',
      [ status, log.transferId ]
    );
    logger.info(
      'saga_log synced to terminal state: transferId=%s step=%s',
      log.transferId, status
    );
    return;
  }

  // status = RESERVED 且 saga_credits 無記錄：Step 2 確認沒做，補償 fromAccount
  logger.info(
    'RESERVED with no credit, compensating fromAccount: transferId=%s',
    log.transferId
  );

  const client = await fromShardPg.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '500ms'");

    // ✅ guard: AND reserved_balance >= $1
    // 防止 recovery 重跑時 reserved_balance 已歸零，UPDATE 讓它變負數
    const compensateResult = await client.query(
      `
        UPDATE accounts
        SET
          available_balance = available_balance + $1,
          reserved_balance  = reserved_balance - $1,
          updated_at        = NOW()
        WHERE id = $2
          AND reserved_balance >= $1
        RETURNING id
      `,
      [ log.amount, log.fromAccountId ]
    );

    // rowCount = 0：reserved_balance 不足，資料已不一致，標記 NEEDS_REVIEW
    if (compensateResult.rowCount === 0) {
      await client.query(
        'UPDATE transfers SET status = $1, updated_at = NOW() WHERE id = $2',
        [ 'FAILED', log.transferId ]
      );
      await client.query(
        'UPDATE saga_log SET step = $1, updated_at = NOW() WHERE transfer_id = $2',
        [ 'NEEDS_REVIEW', log.transferId ]
      );
      await client.query('COMMIT');
      logger.error('========================================');
      logger.error('CRITICAL: saga recovery requires manual intervention (RESERVED compensate)');
      logger.error('  transferId    = %s', log.transferId);
      logger.error('  fromAccountId = %s (shard %d)', log.fromAccountId, log.fromShardId);
      logger.error('  amount        = %s', log.amount);
      logger.error('  reserved_balance is insufficient — may have been double-compensated');
      logger.error('ACTION REQUIRED:');
      logger.error('  1. verify fromAccount id=%s reserved_balance on shard %d', log.fromAccountId, log.fromShardId);
      logger.error('  2. manually fix: UPDATE accounts SET available_balance = available_balance + %s, reserved_balance = reserved_balance - %s WHERE id = %s;', log.amount, log.amount, log.fromAccountId);
      logger.error('  3. UPDATE saga_log SET step = \'FAILED\' WHERE transfer_id = %s;', log.transferId);
      logger.error('========================================');
      return;
    }

    await client.query(
      'UPDATE transfers SET status = $1, updated_at = NOW() WHERE id = $2',
      [ 'FAILED', log.transferId ]
    );

    await client.query(
      'UPDATE saga_log SET step = $1, updated_at = NOW() WHERE transfer_id = $2',
      [ 'FAILED', log.transferId ]
    );

    await client.query('COMMIT');

    logger.info('RESERVED compensated: transferId=%s', log.transferId);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { void e; }
    throw err;
  } finally {
    client.release();
  }
}

// step = CREDITED：Step 2 commit 了，Step 3 沒完成
// 先嘗試重跑 Step 3（finalize），若失敗改走補償路徑
//
// ╔══════════════════════════════════════════════════════════════════════╗
// ║ 🚨 CRITICAL BUG: Race with queue_worker can reverse COMPLETED transfers ║
// ╚══════════════════════════════════════════════════════════════════════╝
//
// 問題描述（Race condition scenario）：
//   1. queue_worker 執行 Step 3 finalize：reserved_balance -= amount，
//      transfers.status = 'COMPLETED'，saga_log.step = 'COMPLETED'，全部在同一 tx commit。
//   2. 但在 Step 3 commit 之前，recovery_worker 掃到 saga_log.step = 'CREDITED'
//      （因為 STALE_THRESHOLD=30s，而 queue 積壓導致 CREDITED 停留 > 30s）。
//   3. queue_worker 的 Step 3 commit 成功（saga_log.step 現在已是 COMPLETED）。
//   4. recovery_worker 執行 finalizeResult：UPDATE WHERE reserved_balance >= $1
//      → reserved_balance 已是 0，rowCount = 0。
//   5. recovery_worker 誤判「finalize 失敗」，呼叫 compensateCredited：
//      → toAccount 被扣回 amount（已入帳的金額被撤銷）
//      → fromAccount 的 reserved 被還原
//      → transfers.status 被改為 'FAILED'
//   6. 結果：queue_worker 回傳 COMPLETED 給用戶，但 recovery_worker 反轉了轉帳。
//      用戶看到成功，但錢實際上沒有轉出，toAccount 也沒有收到錢。
//
// 根本修法（Required fix）：
//   在 finalizeResult.rowCount === 0 時，先查 transfers.status。
//   若為 'COMPLETED'，代表 queue_worker 已完成 finalize，
//   只需同步 saga_log.step = 'COMPLETED' 後返回，不應走補償路徑。
//
//   應加入的程式碼（在 rowCount=0 的 ROLLBACK 後）：
//   ┌─────────────────────────────────────────────────────────────────────
//   │ // 查詢 transfer 是否已完成（check if already finalized by queue worker）
//   │ const transferRow = await fromShardPg.query(
//   │   'SELECT status FROM transfers WHERE id = $1',
//   │   [log.transferId]
//   │ );
//   │ if (transferRow.rows[0]?.status === 'COMPLETED') {
//   │   // queue_worker 已完成 finalize，同步 saga_log 狀態後返回
//   │   await fromShardPg.query(
//   │     'UPDATE saga_log SET step = $1, updated_at = NOW() WHERE transfer_id = $2',
//   │     ['COMPLETED', log.transferId]
//   │   );
//   │   logger.info('transfer already COMPLETED by queue_worker, synced saga_log: transferId=%s', log.transferId);
//   │   return; // 正確返回，不走補償路徑
//   │ }
//   │ // 只有在確認非 COMPLETED 時才走補償路徑
//   │ await compensateCredited(log, shardPgMap);
//   └─────────────────────────────────────────────────────────────────────
async function recoverFromCredited(log, shardPgMap) {
  const fromShardPg = shardPgMap[log.fromShardId];

  logger.info('CREDITED found, attempting finalize: transferId=%s', log.transferId);

  // ✅ [M18 FIXED] 使用 let 而非 const，允許補償路徑提前 release 後設為 null，
  // 防止 finally 對同一個 client 二次 release（double release 造成 pool 計數失準）。
  let client = await fromShardPg.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '500ms'");

    // ✅ guard 已存在：AND reserved_balance >= $1
    const finalizeResult = await client.query(
      `
        UPDATE accounts
        SET
          reserved_balance = reserved_balance - $1,
          balance          = balance - $1,
          updated_at       = NOW()
        WHERE id = $2
          AND reserved_balance >= $1
        RETURNING id
      `,
      [ log.amount, log.fromAccountId ]
    );

    if (finalizeResult.rowCount === 0) {
      await client.query('ROLLBACK');
      logger.warn(
        'finalize failed (reserved mismatch), switching to compensate: transferId=%s',
        log.transferId
      );

      // ⚠️ [LOW BUG — v3 新發現] 此時 `client` 仍持有連線（ROLLBACK 後未 release）。
      // compensateCredited 內部會透過 fromShardPg.connect() 取得另一條連線，
      // 導致同一次 recovery 同時持有最多 3 條 fromShardPg 連線（此 client + compensateCredited 兩個 connect）。
      // 若 SCAN_BATCH_SIZE 大且多 CREDITED 並行，pool 可能提前耗盡，補償失敗。
      // 修法：在此行之前執行 `client.release(); client = null;`，再呼叫 compensateCredited。
      //        注意：release 後不可再呼叫 client.query。
      //
      // ⚠️ [CRITICAL BUG — 尚未修復] 此處缺少 transfers.status 檢查（Missing status check before compensating）
      //
      // reserved_balance = 0 有兩種可能：
      //   (A) queue_worker 已完成 Step 3 finalize（transfers.status = 'COMPLETED'）→ 絕對不應補償！
      //   (B) 真的發生 reserved_balance 不足的異常狀態 → 才應走補償路徑
      //
      // 目前程式碼直接走 compensateCredited，在情境 (A) 下會：
      //   - toAccount 被扣回 amount（已入帳金額被撤銷）
      //   - fromAccount reserved 被還原（實際上已銷帳）
      //   - transfers.status 被改為 'FAILED'（系統記錄與用戶感知矛盾）
      //   → 用戶收到 COMPLETED 但錢沒有真正轉出！
      //
      // ── 應加入的修復程式碼（insert before compensateCredited call）───────────────
      //
      //   const transferRow = await fromShardPg.query(
      //     'SELECT status FROM transfers WHERE id = $1',
      //     [log.transferId]
      //   );
      //   if (transferRow.rows[0]?.status === 'COMPLETED') {
      //     // Case (A)：queue_worker 已完成 finalize，只同步 saga_log 後返回
      //     await fromShardPg.query(
      //       'UPDATE saga_log SET step = $1, updated_at = NOW() WHERE transfer_id = $2',
      //       ['COMPLETED', log.transferId]
      //     );
      //     logger.info('transfer already COMPLETED by queue_worker, synced saga_log: transferId=%s', log.transferId);
      //     return; // ← 正確退出，不走補償
      //   }
      //   // 只有在確認非 COMPLETED 時才繼續走補償路徑（Case B）
      //
      // ── 觸發條件 ─────────────────────────────────────────────────────────────────
      //   queue 積壓 > 30s（STALE_THRESHOLD）且 queue_worker 正在執行或剛完成 Step 3 時觸發。
      //   高負載、worker 重啟、Redis 慢都可能造成此情境。
      //
      // ── 暫時緩解 ──────────────────────────────────────────────────────────────────
      //   將 SAGA_STALE_THRESHOLD_SEC 調高至 120-300s，降低觸發頻率（非根本修法）。
      //
      // ✅ [C1 FIXED] 先查 transfers.status，確認 queue_worker 是否已完成 finalize
      //
      // ⚠️ [v8 — M18] double client.release() 風險（Double release side effect from C1 fix）
      //
      // 問題描述：
      //   此處 `client.release()` 是第一次 release。
      //   但本函數的 `finally { client.release() }` 會在任何 return 後再次執行，
      //   造成 double release（雙重歸還同一條連線到 pool）。
      //
      //   在 node-postgres 中，對同一個 PoolClient 呼叫兩次 release()：
      //   - pool 的可用連線計數可能失準（誤認為歸還了兩條連線）
      //   - 若 release() 之後的程式碼拋錯，catch block 中 client.query('ROLLBACK')
      //     在已 release 的 client 上執行，丟出 "Connection already released"（被靜默吞掉）
      //   - 最終 finally 再次 release 同一個 client，行為為未定義
      //
      // 根本修法：
      //   1. 將 `const client` 改為 `let client`
      //   2. 此行之後加入 `client = null;`
      //   3. catch block 改為 `if (client) { try { await client.query('ROLLBACK'); } ... }`
      //   4. finally 改為 `if (client) client.release();`
      //
      // 暫時影響：
      //   - 功能上 C1 fix 邏輯正確（status check + saga_log 同步正常）
      //   - double release 在低 SCAN_BATCH_SIZE 下不明顯，pool 較大時 pool 計數容差可吸收
      //   - 高 SCAN_BATCH_SIZE 或小 pool（PG_SHARD_POOL_MAX=5）下可能造成 pool 連線洩漏
      //
      // ✅ [M18 FIXED] 提前 release 後立即設為 null，防止 finally 二次 release。
      // 設為 null 後不可再呼叫 client.query（後續改用 fromShardPg 直接查詢）。
      client.release();
      client = null;

      // ✅ [C1 FIXED] 確認 transfers.status，避免誤補償已完成的轉帳
      const transferRow = await fromShardPg.query(
        'SELECT status FROM transfers WHERE id = $1',
        [ log.transferId ]
      );
      if (transferRow.rows[0]?.status === 'COMPLETED') {
        // Case A：queue_worker 已完成 Step 3，只需同步 saga_log 後返回，不走補償
        await fromShardPg.query(
          'UPDATE saga_log SET step = $1, updated_at = NOW() WHERE transfer_id = $2',
          [ 'COMPLETED', log.transferId ]
        );
        logger.info('transfer already COMPLETED by queue_worker, synced saga_log: transferId=%s', log.transferId);
        return;
      }
      // Case B：確認非 COMPLETED，才走補償路徑
      await compensateCredited(log, shardPgMap);
      return;
    }

    await client.query(
      'UPDATE transfers SET status = $1, updated_at = NOW() WHERE id = $2',
      [ 'COMPLETED', log.transferId ]
    );

    await client.query(
      'UPDATE saga_log SET step = $1, updated_at = NOW() WHERE transfer_id = $2',
      [ 'COMPLETED', log.transferId ]
    );

    await client.query('COMMIT');

    logger.info('CREDITED finalized: transferId=%s', log.transferId);
  } catch (err) {
    // ✅ [M18 FIXED] 補償路徑提前 release 後 client 已設為 null，catch 需先判斷
    if (client) { try { await client.query('ROLLBACK'); } catch (e) { void e; } }
    throw err;
  } finally {
    // ✅ [M18 FIXED] 補償路徑已提前 release 並設 null，finally 只在 client 仍持有時才 release
    if (client) client.release();
  }
}

// Step 3 無法完成時的補償路徑：
// 1. 先把 saga_log 推進到 COMPENSATING（crash 重啟後從 COMPENSATING 繼續，不重複扣 toAccount）
// 2. 查 saga_compensations 確認 toAccount 是否已補償（冪等 guard）
// 3. 若未補償，扣回 toAccount（✅ 加 available_balance >= $1 guard）
// 4. 再還原 fromAccount reserved → available（✅ 改用 UPDATE WHERE 取代 SELECT + UPDATE，消除 TOCTOU）
async function compensateCredited(log, shardPgMap) {
  const fromShardPg = shardPgMap[log.fromShardId];
  const toShardPg   = shardPgMap[log.toShardId];

  // 補償 toAccount 前，先把 saga_log 推進到 COMPENSATING
  // 這樣 crash 重啟後可以從 COMPENSATING 繼續，不會重複扣 toAccount
  await fromShardPg.query(
    'UPDATE saga_log SET step = $1, updated_at = NOW() WHERE transfer_id = $2',
    [ 'COMPENSATING', log.transferId ]
  );

  // 查 saga_compensations，確認 toAccount 是否已補償（冪等 guard）
  const alreadyCompensated = await toShardPg.query(
    'SELECT id FROM saga_compensations WHERE transfer_id = $1 LIMIT 1',
    [ log.transferId ]
  );

  if (alreadyCompensated.rowCount === 0) {
    const toClient = await toShardPg.connect();
    try {
      await toClient.query('BEGIN');
      await toClient.query("SET LOCAL lock_timeout = '500ms'");

      // ✅ 新增 guard: AND available_balance >= $1
      // toAccount 的 available_balance 理論上應該足夠（Step 2 加進去了），
      // 但若帳戶在 Step 2 ~ 補償之間被提款到不夠，沒有 guard 會讓 available 變負數
      const compensateToResult = await toClient.query(
        `
          UPDATE accounts
          SET
            balance           = balance - $1,
            available_balance = available_balance - $1,
            updated_at        = NOW()
          WHERE id = $2
            AND available_balance >= $1
        `,
        [ log.amount, log.toAccountId ]
      );

      // rowCount = 0：toAccount 餘額不足，資料已不一致
      // 寫 NEEDS_REVIEW 讓人工介入，不繼續補 fromAccount（否則 fromAccount 的 reserved 永遠卡住）
      if (compensateToResult.rowCount === 0) {
        await toClient.query('ROLLBACK');
        // fromAccount 的 reserved_balance 還是卡住，統一在下方的 fromAccount 段標記 NEEDS_REVIEW
        logger.error('========================================');
        logger.error('CRITICAL: compensate toAccount failed (available_balance insufficient)');
        logger.error('  transferId  = %s', log.transferId);
        logger.error('  toAccountId = %s (shard %d)', log.toAccountId, log.toShardId);
        logger.error('  amount      = %s', log.amount);
        logger.error('  toAccount available_balance is insufficient — needs manual check');
        logger.error('========================================');
        // 標記 NEEDS_REVIEW 並離開，不繼續補 fromAccount
        await fromShardPg.query(
          'UPDATE transfers SET status = $1, updated_at = NOW() WHERE id = $2',
          [ 'FAILED', log.transferId ]
        ).catch(() => {});
        await fromShardPg.query(
          'UPDATE saga_log SET step = $1, updated_at = NOW() WHERE transfer_id = $2',
          [ 'NEEDS_REVIEW', log.transferId ]
        ).catch(() => {});
        return;
      }

      // saga_compensations 和 UPDATE accounts 在同一個 tx
      await toClient.query(
        `
          INSERT INTO saga_compensations (transfer_id)
          VALUES ($1)
          ON CONFLICT (transfer_id) DO NOTHING
        `,
        [ log.transferId ]
      );

      await toClient.query('COMMIT');
    } catch (err) {
      try { await toClient.query('ROLLBACK'); } catch (e) { void e; }
      logger.error(
        'CRITICAL: compensate toAccount failed: transferId=%s err=%s',
        log.transferId, err && err.message
      );
      throw err;
    } finally {
      toClient.release();
    }
  } else {
    logger.info(
      'toAccount already compensated (saga_compensations exists), skipping: transferId=%s',
      log.transferId
    );
  }

  // 補償 fromAccount：還原 reserved → available
  // ✅ 改用 UPDATE WHERE reserved_balance >= $1，消除原本 SELECT + UPDATE 的 TOCTOU 問題
  // 原本是先 SELECT reserved_balance，判斷後再 UPDATE，兩步之間若有並發修改會讀到舊值
  // 改成單一 UPDATE 加 WHERE 條件，由 PG 在鎖定後原子判斷，rowCount=0 才標記 NEEDS_REVIEW
  const fromClient = await fromShardPg.connect();
  try {
    await fromClient.query('BEGIN');
    await fromClient.query("SET LOCAL lock_timeout = '500ms'");

    const compensateFromResult = await fromClient.query(
      `
        UPDATE accounts
        SET
          available_balance = available_balance + $1,
          reserved_balance  = reserved_balance - $1,
          updated_at        = NOW()
        WHERE id = $2
          AND reserved_balance >= $1
        RETURNING id
      `,
      [ log.amount, log.fromAccountId ]
    );

    if (compensateFromResult.rowCount === 0) {
      // reserved_balance 不足：資料已不一致，標記 NEEDS_REVIEW
      await fromClient.query(
        'UPDATE transfers SET status = $1, updated_at = NOW() WHERE id = $2',
        [ 'FAILED', log.transferId ]
      );
      await fromClient.query(
        'UPDATE saga_log SET step = $1, updated_at = NOW() WHERE transfer_id = $2',
        [ 'NEEDS_REVIEW', log.transferId ]
      );
      await fromClient.query('COMMIT');
      logger.error('========================================');
      logger.error('CRITICAL: saga recovery requires manual intervention');
      logger.error('  transferId      = %s', log.transferId);
      logger.error('  fromAccountId   = %s (shard %d)', log.fromAccountId, log.fromShardId);
      logger.error('  toAccountId     = %s (shard %d)', log.toAccountId, log.toShardId);
      logger.error('  amount          = %s', log.amount);
      logger.error('  toAccount       = already compensated (money returned)');
      logger.error('  fromAccount     = reserved_balance insufficient, needs manual clear');
      logger.error('  saga_log        = marked NEEDS_REVIEW, recovery will not retry');
      logger.error('ACTION REQUIRED:');
      logger.error('  1. verify toAccount id=%s balance is correct on shard %d', log.toAccountId, log.toShardId);
      logger.error('  2. manually fix fromAccount id=%s reserved_balance on shard %d', log.fromAccountId, log.fromShardId);
      logger.error('     e.g. UPDATE accounts SET available_balance = available_balance + %s, reserved_balance = reserved_balance - %s WHERE id = %s;', log.amount, log.amount, log.fromAccountId);
      logger.error('  3. UPDATE saga_log SET step = \'FAILED\' WHERE transfer_id = %s;', log.transferId);
      logger.error('========================================');
      return;
    }

    await fromClient.query(
      'UPDATE transfers SET status = $1, updated_at = NOW() WHERE id = $2',
      [ 'FAILED', log.transferId ]
    );

    await fromClient.query(
      'UPDATE saga_log SET step = $1, updated_at = NOW() WHERE transfer_id = $2',
      [ 'FAILED', log.transferId ]
    );

    await fromClient.query('COMMIT');

    logger.info('compensateCredited done: transferId=%s', log.transferId);
  } catch (err) {
    try { await fromClient.query('ROLLBACK'); } catch (e) { void e; }
    logger.error(
      'CRITICAL: compensate fromAccount failed: transferId=%s err=%s',
      log.transferId, err && err.message
    );
    throw err;
  } finally {
    fromClient.release();
  }
}

// step = COMPENSATING：toAccount 補償已觸發（可能成功或 crash），fromAccount 尚未補償
// 查 saga_compensations 確認 toAccount 是否已補償，再決定是否需要補
async function recoverFromCompensating(log, shardPgMap) {
  const fromShardPg = shardPgMap[log.fromShardId];
  const toShardPg   = shardPgMap[log.toShardId];

  logger.info('COMPENSATING found, checking saga_compensations: transferId=%s', log.transferId);

  // 查 toShard 的 saga_compensations 表
  // 若有記錄，代表 toAccount 補償已在同一個 tx 裡完成，直接跳到補償 fromAccount
  // 若沒有記錄，代表補償 toAccount 還沒完成（crash 在 tx commit 之前），需要補
  const compensationResult = await toShardPg.query(
    'SELECT id FROM saga_compensations WHERE transfer_id = $1 LIMIT 1',
    [ log.transferId ]
  );

  const alreadyCompensated = compensationResult.rowCount > 0;

  if (!alreadyCompensated) {
    logger.info('toAccount not yet compensated, compensating: transferId=%s', log.transferId);

    const toClient = await toShardPg.connect();
    try {
      await toClient.query('BEGIN');
      await toClient.query("SET LOCAL lock_timeout = '500ms'");

      // ✅ 新增 guard: AND available_balance >= $1
      // 同 compensateCredited 的 toAccount 段，防止 available 變負數
      const compensateToResult = await toClient.query(
        `
          UPDATE accounts
          SET
            balance           = balance - $1,
            available_balance = available_balance - $1,
            updated_at        = NOW()
          WHERE id = $2
            AND available_balance >= $1
        `,
        [ log.amount, log.toAccountId ]
      );

      if (compensateToResult.rowCount === 0) {
        await toClient.query('ROLLBACK');
        logger.error('========================================');
        logger.error('CRITICAL: compensate toAccount failed in COMPENSATING recovery (available_balance insufficient)');
        logger.error('  transferId  = %s', log.transferId);
        logger.error('  toAccountId = %s (shard %d)', log.toAccountId, log.toShardId);
        logger.error('  amount      = %s', log.amount);
        logger.error('ACTION REQUIRED: manually verify toAccount balance and fromAccount reserved_balance');
        logger.error('========================================');
        // 標記 NEEDS_REVIEW，不繼續補 fromAccount
        await fromShardPg.query(
          'UPDATE transfers SET status = $1, updated_at = NOW() WHERE id = $2',
          [ 'FAILED', log.transferId ]
        ).catch(() => {});
        await fromShardPg.query(
          'UPDATE saga_log SET step = $1, updated_at = NOW() WHERE transfer_id = $2',
          [ 'NEEDS_REVIEW', log.transferId ]
        ).catch(() => {});
        return;
      }

      // 寫入 saga_compensations，和 UPDATE accounts 同一個 tx
      await toClient.query(
        `
          INSERT INTO saga_compensations (transfer_id)
          VALUES ($1)
          ON CONFLICT (transfer_id) DO NOTHING
        `,
        [ log.transferId ]
      );

      await toClient.query('COMMIT');
      logger.info('toAccount compensated in COMPENSATING recovery: transferId=%s', log.transferId);
    } catch (err) {
      try { await toClient.query('ROLLBACK'); } catch (e) { void e; }
      logger.error(
        'CRITICAL: compensate toAccount failed in COMPENSATING recovery: transferId=%s err=%s',
        log.transferId, err && err.message
      );
      throw err;
    } finally {
      toClient.release();
    }
  } else {
    logger.info('toAccount already compensated (saga_compensations exists), skipping: transferId=%s', log.transferId);
  }

  // 補償 fromAccount（和 compensateCredited 後半段相同）
  // ✅ 改用 UPDATE WHERE reserved_balance >= $1，消除 TOCTOU
  const fromClient = await fromShardPg.connect();
  try {
    await fromClient.query('BEGIN');
    await fromClient.query("SET LOCAL lock_timeout = '500ms'");

    const compensateFromResult = await fromClient.query(
      `
        UPDATE accounts
        SET
          available_balance = available_balance + $1,
          reserved_balance  = reserved_balance - $1,
          updated_at        = NOW()
        WHERE id = $2
          AND reserved_balance >= $1
        RETURNING id
      `,
      [ log.amount, log.fromAccountId ]
    );

    if (compensateFromResult.rowCount === 0) {
      await fromClient.query(
        'UPDATE transfers SET status = $1, updated_at = NOW() WHERE id = $2',
        [ 'FAILED', log.transferId ]
      );
      await fromClient.query(
        'UPDATE saga_log SET step = $1, updated_at = NOW() WHERE transfer_id = $2',
        [ 'NEEDS_REVIEW', log.transferId ]
      );
      await fromClient.query('COMMIT');
      logger.error('========================================');
      logger.error('CRITICAL: saga recovery requires manual intervention (COMPENSATING)');
      logger.error('  transferId      = %s', log.transferId);
      logger.error('  fromAccountId   = %s (shard %d)', log.fromAccountId, log.fromShardId);
      logger.error('  toAccountId     = %s (shard %d)', log.toAccountId, log.toShardId);
      logger.error('  amount          = %s', log.amount);
      logger.error('  fromAccount     = reserved_balance insufficient, needs manual clear');
      logger.error('  saga_log        = marked NEEDS_REVIEW, recovery will not retry');
      logger.error('ACTION REQUIRED:');
      logger.error('  1. verify toAccount id=%s balance is correct on shard %d', log.toAccountId, log.toShardId);
      logger.error('  2. manually fix fromAccount id=%s reserved_balance on shard %d', log.fromAccountId, log.fromShardId);
      logger.error('  3. UPDATE saga_log SET step = \'FAILED\' WHERE transfer_id = %s;', log.transferId);
      logger.error('========================================');
      return;
    }

    await fromClient.query(
      'UPDATE transfers SET status = $1, updated_at = NOW() WHERE id = $2',
      [ 'FAILED', log.transferId ]
    );

    await fromClient.query(
      'UPDATE saga_log SET step = $1, updated_at = NOW() WHERE transfer_id = $2',
      [ 'FAILED', log.transferId ]
    );

    await fromClient.query('COMMIT');

    logger.info('COMPENSATING recovery done: transferId=%s', log.transferId);
  } catch (err) {
    try { await fromClient.query('ROLLBACK'); } catch (e) { void e; }
    logger.error(
      'CRITICAL: compensate fromAccount failed in COMPENSATING recovery: transferId=%s err=%s',
      log.transferId, err && err.message
    );
    throw err;
  } finally {
    fromClient.release();
  }
}

// ─── main loop ────────────────────────────────────────────────────────────────

async function main() {
  logger.info('starting: interval=%dms staleThreshold=%ds batchSize=%d',
    INTERVAL_MS, STALE_THRESHOLD, SCAN_BATCH_SIZE);

  const shardPgMap = createShardPgMap();
  const shardIds   = Object.keys(shardPgMap).map(Number);

  // 測試 DB 連線
  for (const shardId of shardIds) {
    const client = await shardPgMap[shardId].connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }
  }
  logger.info('all shard DB connections ok');

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // ⚠️ [v6 — L10] 四個 shard 依序掃描（Sequential shard scan — Risk: LOW）
      //
      // 問題描述：
      //   for...of 迴圈依序等待每個 shard 的 recoverShard 完成後才掃描下一個。
      //   若 shard 0 有 SCAN_BATCH_SIZE=50 筆卡住的 saga，每筆 recovery 最壞情況耗時
      //   數百毫秒（含 DB lock, IO 等待），整輪 recoverShard(0) 可能耗時 5-30 秒。
      //   在此期間，shard 1、2、3 的卡住 saga 無法被處理，積壓持續加重。
      //
      //   在四個 shard 分佈在獨立 PG instance（Docker / 多機）的場景下，
      //   各 shard 之間沒有資源競爭，應可並行掃描，大幅降低 recovery 延遲。
      //
      // 影響：
      //   單個 shard 的 saga 積壓會阻塞其他 shard 的 recovery，
      //   在高負載或 worker 重啟後，recovery lag 可能超過 STALE_THRESHOLD * shardCount。
      //
      // 修法：
      //   改用 Promise.all 並行處理所有 shard：
      //   ```js
      //   await Promise.all(shardIds.map(shardId => recoverShard(shardId, shardPgMap)));
      //   ```
      //   注意：recoverOne 內部各步驟已有自己的 DB 連線（connect/release），
      //   並行執行時需確認 PG_SHARD_POOL_MAX 足夠支撐 SCAN_BATCH_SIZE × 4 shard 的並發連線。
      //
      // Risk level: LOW — 功能不受影響，但在高負載下 recovery 效率偏低。
      // TODO: CONSIDER IMPROVING — Change to Promise.all for parallel shard recovery
      for (const shardId of shardIds) {
        await recoverShard(shardId, shardPgMap);
      }
    } catch (err) {
      logger.error('loop error: %s', err && (err.stack || err.message));
    }
    await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
  }
}

main().catch(err => {
  console.error('[SagaRecovery] fatal:', err);
  process.exit(1);
});