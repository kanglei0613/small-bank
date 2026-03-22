'use strict';

const baseShardRepo = require('./baseShardRepo');

class TransfersRepo extends baseShardRepo {

  async listByAccountId(accountId, limit) {
    const aid = Number(accountId);
    const shardPg = this.getShardPg(this.calcShardId(aid));

    const existsResult = await shardPg.query(
      'SELECT id FROM accounts WHERE id = $1 LIMIT 1',
      [ aid ]
    );

    if (existsResult.rowCount === 0) {
      const { NotFoundError } = require('../lib/errors');
      throw new NotFoundError('account not found');
    }

    const result = await shardPg.query(
      `
        SELECT id, from_account_id AS "fromId", to_account_id AS "toId",
               amount, status, created_at AS "createdAt", updated_at AS "updatedAt"
        FROM transfers
        WHERE from_account_id = $1
        UNION ALL
        SELECT id, from_account_id AS "fromId", to_account_id AS "toId",
               amount, status, created_at AS "createdAt", updated_at AS "updatedAt"
        FROM transfers
        WHERE to_account_id = $1
        ORDER BY id DESC
        LIMIT $2
      `,
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

  async transferSameShard({ fromAccountId, toAccountId, transferAmount, shardId }) {
    const shardPg = this.getShardPg(shardId);
    const client = await shardPg.connect();

    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '200ms'");

      const debitResult = await client.query(
        `
          UPDATE accounts
          SET
            balance = balance - $1,
            available_balance = available_balance - $1,
            updated_at = NOW()
          WHERE id = $2
            AND available_balance >= $1
          RETURNING
            id,
            balance,
            available_balance AS "availableBalance",
            reserved_balance AS "reservedBalance",
            updated_at AS "updatedAt"
        `,
        [ transferAmount, fromAccountId ]
      );

      if (debitResult.rowCount === 0) {
        const { ConflictError } = require('../lib/errors');
        throw new ConflictError('insufficient funds');
      }

      const creditResult = await client.query(
        `
          UPDATE accounts
          SET
            balance = balance + $1,
            available_balance = available_balance + $1,
            updated_at = NOW()
          WHERE id = $2
          RETURNING id
        `,
        [ transferAmount, toAccountId ]
      );

      if (creditResult.rowCount === 0) {
        const { NotFoundError } = require('../lib/errors');
        throw new NotFoundError('destination account not found');
      }

      const insertResult = await client.query(
        `
          INSERT INTO transfers (from_account_id, to_account_id, amount, status, created_at, updated_at)
          VALUES ($1, $2, $3, 'COMPLETED', NOW(), NOW())
          RETURNING id
        `,
        [ fromAccountId, toAccountId, transferAmount ]
      );

      await client.query('COMMIT');

      return {
        transferId: insertResult.rows[0].id,
        fromId: fromAccountId,
        toId: toAccountId,
        amount: transferAmount,
        status: 'COMPLETED',
        shardId,
        type: 'same-shard',
        balance: debitResult.rows[0],
      };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (e) { void e; }
      throw err;
    } finally {
      client.release();
    }
  }

  async transferCrossShard({ fromAccountId, toAccountId, transferAmount, fromShardId, toShardId }) {
    const fromClient = await this.getShardPg(fromShardId).connect();
    const toClient = await this.getShardPg(toShardId).connect();

    let transferId = null;
    let step2Committed = false;

    try {
      // ─────────────────────────────────────────
      // Step 1: reserve on fromShard
      // saga_log INSERT 和業務操作在同一個 tx，保證原子性
      // 若 tx rollback，saga_log 也不會存在，不會有孤立的 log
      // ─────────────────────────────────────────
      await fromClient.query('BEGIN');
      await fromClient.query("SET LOCAL lock_timeout = '200ms'");

      const reserveResult = await fromClient.query(
        `
          UPDATE accounts
          SET
            available_balance = available_balance - $1,
            reserved_balance = reserved_balance + $1,
            updated_at = NOW()
          WHERE id = $2
            AND available_balance >= $1
          RETURNING id
        `,
        [ transferAmount, fromAccountId ]
      );

      if (reserveResult.rowCount === 0) {
        const { ConflictError } = require('../lib/errors');
        throw new ConflictError('insufficient funds');
      }

      const insertResult = await fromClient.query(
        `
          INSERT INTO transfers (from_account_id, to_account_id, amount, status, created_at, updated_at)
          VALUES ($1, $2, $3, 'RESERVED', NOW(), NOW())
          RETURNING id
        `,
        [ fromAccountId, toAccountId, transferAmount ]
      );

      transferId = insertResult.rows[0].id;

      // saga_log 寫在同一個 tx，和 reserve 一起 commit
      // recovery worker 掃到 step='RESERVED' 超過 N 秒 → 代表 Step 2 或補償沒完成
      await fromClient.query(
        `
          INSERT INTO saga_log
            (transfer_id, step, from_account_id, to_account_id, from_shard_id, to_shard_id, amount, updated_at)
          VALUES ($1, 'RESERVED', $2, $3, $4, $5, $6, NOW())
          ON CONFLICT (transfer_id) DO NOTHING
        `,
        [ transferId, fromAccountId, toAccountId, fromShardId, toShardId, transferAmount ]
      );

      await fromClient.query('COMMIT');

      // ─────────────────────────────────────────
      // Step 2: credit on toShard
      // ─────────────────────────────────────────
      await toClient.query('BEGIN');
      await toClient.query("SET LOCAL lock_timeout = '200ms'");

      const creditResult = await toClient.query(
        `
          UPDATE accounts
          SET
            balance = balance + $1,
            available_balance = available_balance + $1,
            updated_at = NOW()
          WHERE id = $2
          RETURNING id
        `,
        [ transferAmount, toAccountId ]
      );

      if (creditResult.rowCount === 0) {
        const { NotFoundError } = require('../lib/errors');
        throw new NotFoundError('destination account not found');
      }

      await toClient.query('COMMIT');
      step2Committed = true;

      // Step 2 commit 成功後推進 saga_log 到 CREDITED
      // 這步失敗沒關係：saga_log 仍是 RESERVED
      // recovery worker 掃到後會重試 Step 2（冪等：重複 credit 同一 transferId 前會先確認）
      await this.getShardPg(fromShardId).query(
        `
          UPDATE saga_log
          SET step = 'CREDITED', updated_at = NOW()
          WHERE transfer_id = $1
        `,
        [ transferId ]
      );

      // ─────────────────────────────────────────
      // Step 3: finalize on fromShard
      // ─────────────────────────────────────────
      await fromClient.query('BEGIN');
      await fromClient.query("SET LOCAL lock_timeout = '200ms'");

      const finalizeResult = await fromClient.query(
        `
          UPDATE accounts
          SET
            reserved_balance = reserved_balance - $1,
            balance = balance - $1,
            updated_at = NOW()
          WHERE id = $2
            AND reserved_balance >= $1
          RETURNING
            id,
            balance,
            available_balance AS "availableBalance",
            reserved_balance AS "reservedBalance",
            updated_at AS "updatedAt"
        `,
        [ transferAmount, fromAccountId ]
      );

      if (finalizeResult.rowCount === 0) {
        const { ConflictError } = require('../lib/errors');
        throw new ConflictError('finalize failed: reserved balance mismatch');
      }

      await fromClient.query(
        `
          UPDATE transfers
          SET status = 'COMPLETED', updated_at = NOW()
          WHERE id = $1
        `,
        [ transferId ]
      );

      // saga_log 標記 COMPLETED（終態），recovery worker 不再碰它
      await fromClient.query(
        `
          UPDATE saga_log
          SET step = 'COMPLETED', updated_at = NOW()
          WHERE transfer_id = $1
        `,
        [ transferId ]
      );

      await fromClient.query('COMMIT');

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
      try { await fromClient.query('ROLLBACK'); } catch (e) { void e; }
      try { await toClient.query('ROLLBACK'); } catch (e) { void e; }

      if (transferId) {
        if (step2Committed) {
          // Step 2 已 commit，先補償 toAccount
          try {
            await toClient.query('BEGIN');
            await toClient.query("SET LOCAL lock_timeout = '200ms'");
            await toClient.query(
              `
                UPDATE accounts
                SET
                  balance = balance - $1,
                  available_balance = available_balance - $1,
                  updated_at = NOW()
                WHERE id = $2
              `,
              [ transferAmount, toAccountId ]
            );
            await toClient.query('COMMIT');
          } catch (e) {
            try { await toClient.query('ROLLBACK'); } catch (e2) { void e2; }
            const logger = this.ctx && this.ctx.logger;
            (logger || console).error(
              '[CrossShard] CRITICAL: compensate toAccount failed, saga_log remains CREDITED for recovery: transferId=%s toAccountId=%s amount=%s err=%s',
              transferId, toAccountId, transferAmount, e && e.message
            );
            // saga_log 仍是 CREDITED，recovery worker 之後掃到會重試補償
            throw err;
          }
        }

        // 補償 fromAccount：還原 reserved → available
        // 移除原本的 AND reserved_balance >= $1 條件，避免靜默失敗（UPDATE 0 rows）
        try {
          await fromClient.query('BEGIN');
          await fromClient.query("SET LOCAL lock_timeout = '200ms'");

          await fromClient.query(
            `
              UPDATE accounts
              SET
                available_balance = available_balance + $1,
                reserved_balance = reserved_balance - $1,
                updated_at = NOW()
              WHERE id = $2
            `,
            [ transferAmount, fromAccountId ]
          );

          await fromClient.query(
            `
              UPDATE transfers
              SET status = 'FAILED', updated_at = NOW()
              WHERE id = $1
            `,
            [ transferId ]
          );

          // saga_log 標記 FAILED（終態），recovery worker 不再處理
          await fromClient.query(
            `
              UPDATE saga_log
              SET step = 'FAILED', updated_at = NOW()
              WHERE transfer_id = $1
            `,
            [ transferId ]
          );

          await fromClient.query('COMMIT');
        } catch (e) {
          try { await fromClient.query('ROLLBACK'); } catch (e2) { void e2; }
          const logger = this.ctx && this.ctx.logger;
          (logger || console).error(
            '[CrossShard] CRITICAL: compensate fromAccount failed, saga_log remains for recovery: transferId=%s fromAccountId=%s amount=%s err=%s',
            transferId, fromAccountId, transferAmount, e && e.message
          );
          // saga_log 仍是 RESERVED，recovery worker 之後掃到會重試
        }
      }

      throw err;
    } finally {
      fromClient.release();
      toClient.release();
    }
  }
}

module.exports = TransfersRepo;
