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

  const map = {};
  for (const [ id, database ] of Object.entries(shardDbs)) {
    map[id] = new Pool({ ...pgBase, database, max: PG_SHARD_POOL_MAX });
  }
  return map;
}

// ─── Recovery logic ───────────────────────────────────────────────────────────

// 掃單一 shard 的 saga_log，找出卡住的記錄
async function recoverShard(fromShardId, shardPgMap) {
  const shardPg = shardPgMap[fromShardId];

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
// 查 transfers.status 確認實際狀態，再決定補償或推進
async function recoverFromReserved(log, shardPgMap) {
  const fromShardPg = shardPgMap[log.fromShardId];

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

  // status = RESERVED：Step 2 確認沒做，直接補償 fromAccount
  logger.info(
    'RESERVED with no credit, compensating fromAccount: transferId=%s',
    log.transferId
  );

  const client = await fromShardPg.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '500ms'");

    await client.query(
      `
        UPDATE accounts
        SET
          available_balance = available_balance + $1,
          reserved_balance  = reserved_balance - $1,
          updated_at        = NOW()
        WHERE id = $2
      `,
      [ log.amount, log.fromAccountId ]
    );

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
async function recoverFromCredited(log, shardPgMap) {
  const fromShardPg = shardPgMap[log.fromShardId];

  logger.info('CREDITED found, attempting finalize: transferId=%s', log.transferId);

  const client = await fromShardPg.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '500ms'");

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
    try { await client.query('ROLLBACK'); } catch (e) { void e; }
    throw err;
  } finally {
    client.release();
  }
}

// Step 3 無法完成時的補償路徑：
// 1. 先扣回 toAccount
// 2. 再還原 fromAccount reserved → available
async function compensateCredited(log, shardPgMap) {
  const fromShardPg = shardPgMap[log.fromShardId];
  const toShardPg   = shardPgMap[log.toShardId];

  // 補償 toAccount 前，先把 saga_log 推進到 COMPENSATING
  // 這樣 crash 重啟後可以從 COMPENSATING 繼續，不會重複扣 toAccount
  await fromShardPg.query(
    'UPDATE saga_log SET step = $1, updated_at = NOW() WHERE transfer_id = $2',
    [ 'COMPENSATING', log.transferId ]
  );

  const toClient = await toShardPg.connect();
  try {
    await toClient.query('BEGIN');
    await toClient.query("SET LOCAL lock_timeout = '500ms'");

    await toClient.query(
      `
        UPDATE accounts
        SET
          balance           = balance - $1,
          available_balance = available_balance - $1,
          updated_at        = NOW()
        WHERE id = $2
      `,
      [ log.amount, log.toAccountId ]
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

  const fromClient = await fromShardPg.connect();
  try {
    await fromClient.query('BEGIN');
    await fromClient.query("SET LOCAL lock_timeout = '500ms'");

    // 先查實際的 reserved_balance
    // 若不足，代表資料已不一致，不能強行扣，改標記 NEEDS_REVIEW 讓人工介入
    const reservedResult = await fromClient.query(
      'SELECT reserved_balance AS "reservedBalance" FROM accounts WHERE id = $1',
      [ log.fromAccountId ]
    );

    const reservedBalance = reservedResult.rows[0] ? Number(reservedResult.rows[0].reservedBalance) : 0;

    if (reservedBalance < log.amount) {
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
      logger.error('  reserved        = %d  (insufficient, need %s)', reservedBalance, log.amount);
      logger.error('  toAccount       = already compensated (money returned)');
      logger.error('  fromAccount     = reserved_balance stuck at %d, needs manual clear', reservedBalance);
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
      `
        UPDATE accounts
        SET
          available_balance = available_balance + $1,
          reserved_balance  = reserved_balance - $1,
          updated_at        = NOW()
        WHERE id = $2
      `,
      [ log.amount, log.fromAccountId ]
    );

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
// 先查 toAccount 的實際狀態判斷是否需要補償，再補償 fromAccount
async function recoverFromCompensating(log, shardPgMap) {
  const fromShardPg = shardPgMap[log.fromShardId];
  const toShardPg   = shardPgMap[log.toShardId];

  logger.info('COMPENSATING found, checking toAccount: transferId=%s', log.transferId);

  // 查 toAccount 目前的 balance
  // 若 balance < 原始值（即已被扣回），表示補償 toAccount 已完成
  // 這裡用一個更直接的方法：查 toShard 是否有對應的 balance 變動記錄
  // 但因為沒有 compensation_log，改用保守做法：
  // 嘗試扣 toAccount，若已扣過會讓 balance 多扣，所以改查 balance 是否足夠
  //
  // 最安全的判斷方式：直接查 toAccount 的 available_balance
  // 若 available_balance >= amount，代表補償 toAccount 可能還沒做，需要補
  // 若 available_balance < amount，代表可能已補償（但這不是絕對準確）
  //
  // 真正安全的做法是在 toShard 加一張 saga_compensations 表，
  // 但目前用保守策略：直接嘗試補償 toAccount，但先查 balance 避免扣到負數
  const toAccountResult = await toShardPg.query(
    'SELECT balance, available_balance AS "availableBalance" FROM accounts WHERE id = $1',
    [ log.toAccountId ]
  );

  if (toAccountResult.rowCount === 0) {
    logger.error('toAccount not found during COMPENSATING recovery: transferId=%s', log.transferId);
    return;
  }

  const { balance, availableBalance } = toAccountResult.rows[0];
  const balanceNum = Number(balance);
  const availableNum = Number(availableBalance);

  // 若 toAccount 的 available_balance >= amount，代表補償可能還沒做，繼續補
  // 若 available_balance < amount，代表可能已補償，直接跳去補償 fromAccount
  if (availableNum >= log.amount) {
    logger.info('toAccount not yet compensated, compensating: transferId=%s', log.transferId);

    const toClient = await toShardPg.connect();
    try {
      await toClient.query('BEGIN');
      await toClient.query("SET LOCAL lock_timeout = '500ms'");

      await toClient.query(
        `
          UPDATE accounts
          SET
            balance           = balance - $1,
            available_balance = available_balance - $1,
            updated_at        = NOW()
          WHERE id = $2
        `,
        [ log.amount, log.toAccountId ]
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
    logger.info('toAccount already compensated (availableBalance=%d < amount=%s), skipping: transferId=%s',
      availableNum, log.amount, log.transferId);
  }

  // 補償 fromAccount（和原本 compensateCredited 後半段相同）
  const fromClient = await fromShardPg.connect();
  try {
    await fromClient.query('BEGIN');
    await fromClient.query("SET LOCAL lock_timeout = '500ms'");

    const reservedResult = await fromClient.query(
      'SELECT reserved_balance AS "reservedBalance" FROM accounts WHERE id = $1',
      [ log.fromAccountId ]
    );

    const reservedBalance = reservedResult.rows[0] ? Number(reservedResult.rows[0].reservedBalance) : 0;

    if (reservedBalance < log.amount) {
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
      logger.error('  reserved        = %d  (insufficient, need %s)', reservedBalance, log.amount);
      logger.error('  saga_log        = marked NEEDS_REVIEW, recovery will not retry');
      logger.error('ACTION REQUIRED:');
      logger.error('  1. verify toAccount id=%s balance is correct on shard %d', log.toAccountId, log.toShardId);
      logger.error('  2. manually fix fromAccount id=%s reserved_balance on shard %d', log.fromAccountId, log.fromShardId);
      logger.error('  3. UPDATE saga_log SET step = \'FAILED\' WHERE transfer_id = %s;', log.transferId);
      logger.error('========================================');
      return;
    }

    await fromClient.query(
      `
        UPDATE accounts
        SET
          available_balance = available_balance + $1,
          reserved_balance  = reserved_balance - $1,
          updated_at        = NOW()
        WHERE id = $2
      `,
      [ log.amount, log.fromAccountId ]
    );

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
