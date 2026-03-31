'use strict';

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
    const fromClient = await this.getShardPg(fromShardId).connect();
    const toClient = await this.getShardPg(toShardId).connect();
    let transferId = null;

    try {
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
      fromClient.release();
      toClient.release();
    }
  }

  // CREDITED補償邏輯：把已入帳的 toAccount 扣回來
  // ✅ 加 AND available_balance >= $1 guard，防止餘額變負數
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