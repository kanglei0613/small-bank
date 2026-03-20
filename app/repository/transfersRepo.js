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
      // Step 1: reserve on from shard
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
      await fromClient.query('COMMIT');

      // Step 2: credit on to shard
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

      // Step 3: finalize on from shard
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
        throw new ConflictError('insufficient funds');
      }

      await fromClient.query(
        `
          UPDATE transfers
          SET status = 'COMPLETED', updated_at = NOW()
          WHERE id = $1
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
                  AND available_balance >= $1
              `,
              [ transferAmount, toAccountId ]
            );
            await toClient.query('COMMIT');
          } catch (e) {
            void e;
            try { await toClient.query('ROLLBACK'); } catch (e2) { void e2; }
          }
        }

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
                AND reserved_balance >= $1
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
          await fromClient.query('COMMIT');
        } catch (e) {
          void e;
          try { await fromClient.query('ROLLBACK'); } catch (e2) { void e2; }
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
