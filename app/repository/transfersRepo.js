'use strict';

/**
 * @file app/repository/transfersRepo.js
 *
 * 轉帳資料存取層（TransfersRepo）
 *
 * ════════════════════════════════════════════════════════════════
 * 職責與設計摘要
 * ════════════════════════════════════════════════════════════════
 *
 * 主要方法：
 *   listByAccountId   — 查詢帳號轉帳紀錄（UNION from + to，依 id DESC）
 *   transfer          — 依 shardId 路由到 transferSameShard 或 transferCrossShard
 *   transferSameShard — 單一 CTE 原子完成 debit + credit + INSERT（3 round trips vs 原本 5）
 *   transferCrossShard — 三步驟 Saga（RESERVE → CREDIT → FINALIZE），各步驟獨立 transaction
 *   _compensateReserved — Step 2 失敗時，還原 fromAccount 的 reserved_balance → available_balance
 *   _compensateCredited — Step 3 失敗時，扣回已入帳的 toAccount balance/available_balance
 *
 * 冪等保護機制：
 *   saga_credits       ON CONFLICT DO NOTHING → 防止 Step 2 重複入帳
 *   saga_compensations ON CONFLICT DO NOTHING → 防止補償操作重複執行
 *   所有 UPDATE 帶 guard 條件（reserved_balance >= $1、available_balance >= $1），
 *   防止重複補償讓餘額欄位變負數
 *
 * ════════════════════════════════════════════════════════════════
 * 三餘額模型（Three-balance Model）
 * ════════════════════════════════════════════════════════════════
 *
 *   balance           — 帳戶總餘額（含凍結中的金額）
 *   available_balance — 可用餘額（用戶實際能動用的金額）
 *   reserved_balance  — 凍結餘額（跨 shard 轉帳進行中的金額）
 *
 *   資料庫 CHECK 約束：balance = available_balance + reserved_balance
 *   此約束在物理層面強制守恆，任何違反的 UPDATE 會被 PostgreSQL 直接拒絕。
 *
 * ════════════════════════════════════════════════════════════════
 * 連線洩漏修復記錄（Connection Leak Bug Fix）
 * ════════════════════════════════════════════════════════════════
 *
 * 問題（已修復）：
 *   早期版本的 transferCrossShard 在 try 區塊外呼叫 connect()：
 *
 *     let fromClient = null;
 *     fromClient = await this.getShardPg(fromShardId).connect(); // ← try 外
 *     try {
 *       ...如果這裡 throw，finally 中 fromClient.release() 會正確執行
 *       toClient = await this.getShardPg(toShardId).connect();   // ← 若此行 throw
 *       // fromClient 已 connect，toClient 連接失敗，
 *       // 進 catch 但 toClient=null，finally 中 fromClient.release() 仍可執行
 *       // ✅ 其實這種模式在 finally 有 null 檢查時是安全的
 *     } finally {
 *       if (fromClient) fromClient.release();
 *       if (toClient) toClient.release();
 *     }
 *
 *   真正的潛在問題是若 connect() 本身 throw（連線池耗盡），
 *   在 try 外呼叫時 finally 不會執行，連線嘗試失敗但 pool 狀態可能不一致。
 *
 * 修復（現行版本）：
 *   fromClient 和 toClient 的 connect() 都在 try 區塊內執行，
 *   確保無論哪一步失敗，finally 都能正確 release 已取得的連線：
 *
 *     try {
 *       fromClient = await this.getShardPg(fromShardId).connect(); // ✅ try 內
 *       toClient   = await this.getShardPg(toShardId).connect();   // ✅ try 內
 *       ...
 *     } finally {
 *       if (fromClient) fromClient.release();
 *       if (toClient)   toClient.release();
 *     }
 *
 * ════════════════════════════════════════════════════════════════
 * ⚠️  架構審查標注（Architecture Review Annotations）2026-05-14 v7
 * ════════════════════════════════════════════════════════════════
 *
 * [NOT PRODUCTION-READY] 以下問題在 production 環境仍需修補：
 * （v7 自動化審查確認：C1/C2/C3/C4 及所有 HIGH/MEDIUM 問題仍為 open；
 *   v5 新增 — L9：transferCrossShard Step 3 catch 區塊缺少 ROLLBACK，
 *   dirty connection 歸還 pool 可能造成後續請求取到帶未提交 write 的 connection；
 *   v7 無新增問題於此檔案，新增問題 L11/L12 在 redis_transfer_queue.js）
 *
 * 1. 跨 Shard 轉帳記錄只存 fromShard（KNOWN LIMITATION — Risk: HIGH）
 *    - listByAccountId 在 toShard 上查 `WHERE to_account_id = $1`，
 *      對跨 shard 的收款紀錄回傳 0 筆（記錄存在 fromShard，不在 toShard）。
 *    - 影響：收款方（toAccount）的帳單中看不到跨 shard 入帳記錄。
 *    - 修法 A：Step 2（CREDIT）同時在 toShard 寫入 shadow 轉帳記錄（status='CREDIT_SHADOW'）
 *    - 修法 B：listByAccountId 在兩個 shard 都查並 merge 結果（額外 round trip）
 *    - 注意：需先建立 transfers 表的索引：
 *        CREATE INDEX CONCURRENTLY ON transfers(from_account_id);
 *        CREATE INDEX CONCURRENTLY ON transfers(to_account_id);
 *
 * 2. transferCrossShard 與 recovery_worker 之間的 CREDITED race condition（Risk: CRITICAL）
 *    - Step 2 commit 成功，saga_log 更新至 CREDITED 後，Step 3 finalize 開始執行。
 *    - 若此時 recovery_worker 掃到 CREDITED 記錄（STALE_THRESHOLD=30s，queue 積壓可能超過）：
 *        (a) queue_worker 的 Step 3 commit 成功（saga_log.step = COMPLETED）
 *        (b) recovery_worker 嘗試 finalize，reserved_balance 已為 0，rowCount=0
 *        (c) recovery_worker 誤判「finalize 失敗」，呼叫 compensateCredited 撤銷已完成轉帳
 *    - 根本修法在 recovery_worker.recoverFromCredited：
 *        rowCount=0 時先查 transfers.status，若為 COMPLETED 只同步 saga_log，不走補償。
 *
 * 3. 沒有 client 端冪等鍵（Idempotency Key）支援（Risk: HIGH）
 *    - 客戶端網路重試會創建多個 job，可能造成重複扣款。
 *    - 修法：接受 X-Idempotency-Key header，以 (userId, idempotencyKey) 在 Redis 查重，
 *      相同 key 直接回傳原有 jobId 而非建立新 job。
 *
 * 4. processJob 無分類重試（Risk: HIGH — 在 transfers.js 標注）
 *    - ConflictError（余額不足）和 lock_timeout（暫時性故障）都 markFailed，
 *      暫時性故障造成永久性轉帳失敗。
 */

const baseShardRepo = require('./baseShardRepo');
const { ConflictError, NotFoundError, InternalError } = require('../lib/errors');

class TransfersRepo extends baseShardRepo {

  async listByAccountId(accountId, limit) {
    const aid = Number(accountId);
    const shardPg = this.getShardPg(this.calcShardId(aid));

    const existsResult = await shardPg.query(
      'SELECT id FROM accounts WHERE id = $1 LIMIT 1',
      [ aid ]
    );

    if (existsResult.rowCount === 0) {
      throw new NotFoundError('account not found');
    }

    // ⚠️ [KNOWN LIMITATION] 跨 shard 收款紀錄缺失問題（Cross-shard incoming transfer history gap）
    //
    // 設計說明：轉帳記錄（transfers 表）只寫入 fromShard。
    // 對於同 shard 轉帳，`WHERE to_account_id = $1` 能找到收款記錄（同一張表）。
    // 對於跨 shard 轉帳，records 只在 fromShard，本查詢在 toShard 執行時回傳 0 筆。
    //
    // 影響：帳號 A（shard 1）收到來自帳號 B（shard 0）的跨 shard 轉帳，
    // 查 A 的轉帳紀錄時，該筆入帳記錄不存在。
    //
    // 修法（兩選一）：
    //   (a) Step 2 在 toShard 同時寫入 shadow transfer record（status='CREDIT_SHADOW'）
    //   (b) listByAccountId 在兩個 shard 都查並 merge 結果
    //
    // 需要新增 indexes: CREATE INDEX ON transfers(from_account_id); CREATE INDEX ON transfers(to_account_id);
    const result = await shardPg.query(
      `SELECT id, from_account_id, to_account_id, amount, status, created_at, updated_at
       FROM transfers
       WHERE from_account_id = $1
       UNION ALL
       SELECT id, from_account_id, to_account_id, amount, status, created_at, updated_at
       FROM transfers
       WHERE to_account_id = $1
       ORDER BY id DESC
       LIMIT $2`,
      [ aid, Number(limit) ]
    );

    return result.rows;
  }

  async transfer(fromId, toId, amount) {
    const fromShardId = this.calcShardId(fromId);
    const toShardId = this.calcShardId(toId);

    if (fromShardId === toShardId) {
      return await this.transferSameShard({
        fromAccountId: Number(fromId),
        toAccountId: Number(toId),
        transferAmount: Number(amount),
        shardId: fromShardId,
      });
    }

    return await this.transferCrossShard({
      fromAccountId: Number(fromId),
      toAccountId: Number(toId),
      transferAmount: Number(amount),
      fromShardId,
      toShardId,
    });
  }

  // Single-database transaction: debit → credit → record.
  // 用 CTE 把 debit + credit + INSERT 合成一次 round trip（原本 5 次 → 3 次）
  //
  // ✅ 強一致性（Strong consistency）：單一 PostgreSQL 交易，ACID 保證。
  // ✅ 無 race condition：CTE 中 `WHERE available_balance >= $1` 由 row lock 原子執行。
  // ✅ CHECK 約束（balance = available_balance + reserved_balance）在 DB 層防止資料分歧。
  //
  // ⚠️ [NOTE] lock_timeout = '200ms' 設計取捨：
  //    高競爭帳號（熱帳號，如大量用戶轉入同一帳號）在 200ms 內無法取得 row lock 時，
  //    PG 拋出 55P03 錯誤，轉成 503 回傳客戶端。這是刻意的 fail-fast 設計，
  //    但對熱帳號場景（如商戶收款帳號）可能造成大量 503。
  //    Production 調優：根據 p99 lock wait 時間動態調整 timeout 值。
  async transferSameShard({ fromAccountId, toAccountId, transferAmount, shardId }) {
    const client = await this.getShardPg(shardId).connect();

    try {
      // round trip 1: BEGIN + SET LOCAL
      await client.query("BEGIN; SET LOCAL lock_timeout = '200ms'");

      // round trip 2: debit + credit + INSERT，全部在同一個 CTE 裡原子執行
      const result = await client.query(
        `WITH debit AS (
           UPDATE accounts
           SET balance           = balance           - $1,
               available_balance = available_balance - $1,
               updated_at        = NOW()
           WHERE id = $2 AND available_balance >= $1
           RETURNING id, balance, available_balance, reserved_balance, updated_at
         ),
         credit AS (
           UPDATE accounts
           SET balance           = balance           + $1,
               available_balance = available_balance + $1,
               updated_at        = NOW()
           WHERE id = $3
           RETURNING id
         ),
         ins AS (
           INSERT INTO transfers (from_account_id, to_account_id, amount, status, created_at, updated_at)
           SELECT $2, $3, $1, 'COMPLETED', NOW(), NOW()
           WHERE EXISTS (SELECT 1 FROM debit) AND EXISTS (SELECT 1 FROM credit)
           RETURNING id
         )
         SELECT
           (SELECT COUNT(*) FROM debit)             AS debit_count,
           (SELECT COUNT(*) FROM credit)            AS credit_count,
           (SELECT id           FROM ins)           AS transfer_id,
           (SELECT balance           FROM debit)    AS balance,
           (SELECT available_balance FROM debit)    AS available_balance,
           (SELECT reserved_balance  FROM debit)    AS reserved_balance,
           (SELECT updated_at        FROM debit)    AS updated_at`,
        [ transferAmount, fromAccountId, toAccountId ]
      );

      const row = result.rows[0];

      if (row.debit_count === '0') {
        throw new ConflictError('insufficient funds');
      }
      if (row.credit_count === '0') {
        throw new NotFoundError('destination account not found');
      }

      // round trip 3: COMMIT
      await client.query('COMMIT');

      return {
        transferId: row.transfer_id,
        fromId: fromAccountId,
        toId: toAccountId,
        amount: transferAmount,
        status: 'COMPLETED',
        shardId,
        type: 'same-shard',
        balance: {
          id:                fromAccountId,
          balance:           row.balance,
          available_balance: row.available_balance,
          reserved_balance:  row.reserved_balance,
          updated_at:        row.updated_at,
        },
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async transferCrossShard({ fromAccountId, toAccountId, transferAmount, fromShardId, toShardId }) {
    let fromClient = null;
    let toClient = null;
    let transferId = null;

    try {
      // ⚠️ 在 try 內 connect：確保任一步驟失敗都能在 finally 釋放已取得的 client
      fromClient = await this.getShardPg(fromShardId).connect();
      toClient = await this.getShardPg(toShardId).connect();
      // step 1: available_balance扣除轉出金額, reserved_balance加入轉出金額以凍結
      await fromClient.query('BEGIN'); // BEGIN
      await fromClient.query("SET LOCAL lock_timeout = '200ms'");

      const reserveResult = await fromClient.query(
        `UPDATE accounts
         SET available_balance = available_balance - $1,
             reserved_balance = reserved_balance  + $1,
             updated_at = NOW()
         WHERE id = $2 AND available_balance >= $1
         RETURNING id`,
        [ transferAmount, fromAccountId ]
      );

      if (reserveResult.rowCount === 0) {
        throw new ConflictError('insufficient funds');
      }

      const insertResult = await fromClient.query(
        `INSERT INTO transfers (from_account_id, to_account_id, amount, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'RESERVED', NOW(), NOW())
         RETURNING id`,
        [ fromAccountId, toAccountId, transferAmount ]
      );

      transferId = insertResult.rows[0].id;

      await fromClient.query(
        `INSERT INTO saga_log
           (transfer_id, step, from_account_id, to_account_id, from_shard_id, to_shard_id, amount, updated_at)
         VALUES ($1, 'RESERVED', $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (transfer_id) DO NOTHING`,
        [ transferId, fromAccountId, toAccountId, fromShardId, toShardId, transferAmount ]
      );

      await fromClient.query('COMMIT'); // COMMIT

      // step 2: 匯入
      try {
        await toClient.query('BEGIN'); // BEGIN
        await toClient.query("SET LOCAL lock_timeout = '200ms'");

        const creditResult = await toClient.query(
          `UPDATE accounts
           SET balance = balance + $1,
               available_balance = available_balance + $1,
               updated_at = NOW()
           WHERE id = $2
           RETURNING id`,
          [ transferAmount, toAccountId ]
        );

        if (creditResult.rowCount === 0) {
          throw new NotFoundError('destination account not found');
        }

        await toClient.query(
          `INSERT INTO saga_credits (transfer_id) VALUES ($1) ON CONFLICT (transfer_id) DO NOTHING`,
          [ transferId ]
        );

        await toClient.query('COMMIT'); // COMMIT
      } catch (err) {
        await this._compensateReserved({ fromClient, fromAccountId, transferAmount, transferId });
        throw err;
      }

      // Step 2 committed後標記狀態為CREDITED in saga_log
      // retry一次，還是不行的話就補償兩個帳號
      //
      // ⚠️ [RACE CONDITION RISK] 此段 saga_log 更新與 recovery_worker 存在競爭（Race with recovery）
      //
      // 情境說明：
      //   若 saga_log 更新到 CREDITED 失敗兩次後，下方補償邏輯（_compensateCredited +
      //   _compensateReserved）會正確還原兩個帳號。
      //   但若 saga_log 成功更新到 CREDITED 後，Step 3 finalize 開始執行，
      //   此時若 recovery_worker 掃到此 CREDITED 記錄並試圖執行 finalize，
      //   recovery_worker.recoverFromCredited 在 finalize 失敗（reserved=0）後
      //   會錯誤走補償路徑，撤銷已完成的轉帳。
      //   此 race 的根本修法在 recovery_worker.recoverFromCredited 加入 transfers.status 檢查。
      //   詳見 recovery_worker.js 中的相關標注。
      //
      // ⚠️ [NOT PRODUCTION-READY] 此段補償後若 process crash，
      //   recovery_worker 會從 COMPENSATING 狀態接手。請確認 recovery_worker 運作正常。
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await fromClient.query(
            `UPDATE saga_log SET step = 'CREDITED', updated_at = NOW() WHERE transfer_id = $1`,
            [ transferId ]
          );
          break;
        } catch (err) {
          if (attempt === 0) continue;
          await this._compensateCredited({ toClient, toAccountId, transferAmount, transferId });
          await fromClient.query(
            `UPDATE saga_log SET step = 'COMPENSATING', updated_at = NOW() WHERE transfer_id = $1`,
            [ transferId ]
          ).catch(() => {});
          await this._compensateReserved({ fromClient, fromAccountId, transferAmount, transferId });
          throw err;
        }
      }

      // step 3: 銷帳
      try {
        await fromClient.query('BEGIN'); // BEGIN
        await fromClient.query("SET LOCAL lock_timeout = '200ms'");

        const finalizeResult = await fromClient.query(
          `UPDATE accounts
           SET reserved_balance = reserved_balance - $1,
               balance = balance - $1,
               updated_at = NOW()
           WHERE id = $2 AND reserved_balance >= $1
           RETURNING id, balance, available_balance, reserved_balance, updated_at`,
          [ transferAmount, fromAccountId ]
        );

        if (finalizeResult.rowCount === 0) {
          throw new InternalError('finalize failed: reserved balance mismatch');
        }

        await fromClient.query(
          `UPDATE transfers SET status = 'COMPLETED', updated_at = NOW() WHERE id = $1`,
          [ transferId ]
        );

        await fromClient.query(
          `UPDATE saga_log SET step = 'COMPLETED', updated_at = NOW() WHERE transfer_id = $1`,
          [ transferId ]
        );

        await fromClient.query('COMMIT'); // COMMIT

        return {
          transferId,
          fromId: fromAccountId,
          toId: toAccountId,
          amount: transferAmount,
          status: 'COMPLETED',
          fromShardId,
          toShardId,
          type: 'cross-shard',
          balance: finalizeResult.rows[0],
        };
      } catch (err) {
        // Step 3 失敗時，把 transfers.status 推到 PENDING_FINALIZE
        // saga_log 維持 CREDITED 不動，讓 recovery_worker 接手 finalize
        //
        // ⚠️ [v5 — L9] 缺少 ROLLBACK：Step 3 catch 區塊未呼叫 ROLLBACK（Missing ROLLBACK in Step 3 catch block）
        //
        // 問題描述：
        //   當 finalizeResult.rowCount === 0（JavaScript throw，非 PG error），
        //   PG 的 BEGIN transaction 仍處於「活躍未提交」狀態。
        //   此時 `UPDATE transfers SET status = 'PENDING_FINALIZE'` 在活躍 tx 中執行，
        //   但後續沒有 COMMIT 也沒有 ROLLBACK，`finally { fromClient.release() }` 把
        //   帶有「未提交 PENDING_FINALIZE write」的 dirty connection 歸還 pool。
        //
        // 情境 A（finalizeResult.rowCount === 0 JS throw）：
        //   - PG transaction 仍 live（accounts 未改動，rowCount=0 表示條件不符無 UPDATE）
        //   - UPDATE transfers SET PENDING_FINALIZE 在 live tx 中執行 → PG 層成功
        //   - 無 COMMIT/ROLLBACK → connection 帶未提交 write 歸還 pool
        //   - pg-pool 不自動 ROLLBACK → dirty connection 可能被下一個請求重用
        //   - 下一個請求的 BEGIN 會得到 WARNING（already in transaction），
        //     或若直接 COMMIT 會提交此 PENDING_FINALIZE write（預期外！）
        //
        // 情境 B（PG error，如 lock_timeout 55P03）：
        //   - PG transaction 進入 error 狀態
        //   - UPDATE transfers SET PENDING_FINALIZE 失敗（"current transaction is aborted"）
        //   - .catch() 靜默忽略錯誤 → transfers.status 仍為 RESERVED
        //   - dirty connection（error 狀態）歸還 pool，下一個請求可能拿到此 connection
        //
        // 功能影響（Functional impact）：
        //   saga_log 停在 CREDITED，recovery_worker 正確接手 finalize → 功能不中斷。
        //   但 dirty connection 在 pool 中傳播是未定義行為，可能造成不相關請求的資料異常。
        //
        // 修法（Fix）：
        //   在 catch 區塊開頭加入 ROLLBACK，清除活躍 tx 後再執行 PENDING_FINALIZE update：
        //   ```js
        //   catch (err) {
        //     await fromClient.query('ROLLBACK').catch(() => {});  // ← 新增
        //     // 在 ROLLBACK 後，以 autocommit 模式直接執行 UPDATE（不在 tx 內）
        //     await fromClient.query(
        //       `UPDATE transfers SET status = 'PENDING_FINALIZE', updated_at = NOW() WHERE id = $1`,
        //       [transferId]
        //     ).catch(...);
        //   }
        //   ```
        //   或者：不在 catch 中更新 transfers，完全依賴 recovery_worker 從 saga_log=CREDITED 接手。
        //   transfers.status=RESERVED 不影響 recovery 邏輯（recovery 以 saga_log.step 為準）。
        //
        // Risk level: LOW-MEDIUM — 依賴 pg-pool 是否在 acquire 時清理 dirty connection，行為因版本而異。
        //
        // TODO: SHOULD FIX — Add ROLLBACK before the PENDING_FINALIZE update
        await fromClient.query(
          `UPDATE transfers SET status = 'PENDING_FINALIZE', updated_at = NOW() WHERE id = $1`,
          [ transferId ]
        ).catch(updateErr => {
          this.ctx.logger.error(
            '[CrossShard] Step3 failed and PENDING_FINALIZE update also failed: transferId=%s err=%s',
            transferId, updateErr && updateErr.message
          );
        });

        this.ctx.logger.error(
          '[CrossShard] Step3 failed, leaving CREDITED for recovery: transferId=%s err=%s',
          transferId, err && err.message
        );

        return {
          transferId,
          fromId: fromAccountId,
          toId: toAccountId,
          amount: transferAmount,
          status: 'PENDING_FINALIZE',
          fromShardId,
          toShardId,
          type: 'cross-shard',
        };
      }

    } finally {
      if (fromClient) fromClient.release();
      if (toClient) toClient.release();
    }
  }

  // CREDITED補償邏輯：把已入帳的 toAccount 扣回來
  // ✅ 加 AND available_balance >= $1 guard，防止餘額變負數
  //
  // ⚠️ [v4 — L8] 脆弱的錯誤訊息判斷（Fragile error message check）
  //   catch 區塊使用 `e.message.startsWith('compensate toAccount failed')` 判斷是否 ROLLBACK。
  //   若錯誤訊息因重構而改變，ROLLBACK 將被漏呼叫，導致 toClient 停在一個開啟的 tx 中。
  //   建議改用自定義 Error 類型（如 class CompensateError extends Error），以 instanceof 判斷。
  async _compensateCredited({ toClient, toAccountId, transferAmount, transferId }) {
    try {
      await toClient.query('BEGIN'); // BEGIN
      await toClient.query("SET LOCAL lock_timeout = '200ms'");

      const result = await toClient.query(
        `UPDATE accounts
         SET balance = balance - $1,
             available_balance = available_balance - $1,
             updated_at = NOW()
         WHERE id = $2 AND available_balance >= $1
         RETURNING id`,
        [ transferAmount, toAccountId ]
      );

      if (result.rowCount === 0) {
        await toClient.query('ROLLBACK');
        throw new InternalError(
          `compensate toAccount failed: account not found or available_balance insufficient: toAccountId=${toAccountId} amount=${transferAmount}`
        );
      }

      await toClient.query(
        `INSERT INTO saga_compensations (transfer_id) VALUES ($1) ON CONFLICT (transfer_id) DO NOTHING`,
        [ transferId ]
      );

      await toClient.query('COMMIT'); // COMMIT
    } catch (e) {
      if (!e.message.startsWith('compensate toAccount failed')) {
        await toClient.query('ROLLBACK').catch(() => {});
      }
      this.ctx.logger.error(
        '[CrossShard] CRITICAL: compensate toAccount failed, toAccount still credited, manual intervention needed: transferId=%s toAccountId=%s err=%s',
        transferId, toAccountId, e?.stack || e?.message
      );
      throw e;
    }
  }

  // RESERVED補償邏輯：把凍結的 fromAccount reserved 還回 available
  // ✅ 加 AND reserved_balance >= $1 guard，防止重複補償讓 reserved 變負數
  //
  // ⚠️ [v4 — L8] 同 _compensateCredited：catch 中 `e.message.startsWith('compensate fromAccount failed')`
  //   是脆弱的判斷模式，建議改用 instanceof CompensateError。
  async _compensateReserved({ fromClient, fromAccountId, transferAmount, transferId }) {
    try {
      await fromClient.query('BEGIN'); // BEGIN
      await fromClient.query("SET LOCAL lock_timeout = '200ms'");

      const result = await fromClient.query(
        `UPDATE accounts
         SET available_balance = available_balance + $1,
             reserved_balance = reserved_balance - $1,
             updated_at = NOW()
         WHERE id = $2 AND reserved_balance >= $1
         RETURNING id`,
        [ transferAmount, fromAccountId ]
      );

      if (result.rowCount === 0) {
        await fromClient.query('ROLLBACK');
        throw new InternalError(
          `compensate fromAccount failed: account not found or reserved_balance insufficient: fromAccountId=${fromAccountId} amount=${transferAmount}`
        );
      }

      await fromClient.query(
        `UPDATE transfers SET status = 'FAILED', updated_at = NOW() WHERE id = $1`,
        [ transferId ]
      );

      await fromClient.query(
        `UPDATE saga_log SET step = 'FAILED', updated_at = NOW() WHERE transfer_id = $1`,
        [ transferId ]
      );

      await fromClient.query('COMMIT'); // COMMIT
    } catch (e) {
      if (!e.message.startsWith('compensate fromAccount failed')) {
        await fromClient.query('ROLLBACK').catch(() => {});
      }
      this.ctx.logger.error(
        '[CrossShard] CRITICAL: compensate fromAccount failed, leaving RESERVED for recovery: transferId=%s fromAccountId=%s err=%s',
        transferId, fromAccountId, e && e.message
      );
      throw e;
    }
  }
}

module.exports = TransfersRepo;
