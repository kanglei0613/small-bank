'use strict';

/**
 * Accounts repository
 */
class AccountsRepo {

  /**
   * @param {import('egg').Context} ctx - Egg context
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.metaPg = ctx.app.metaPg;
  }

  /**
   * Calculate shard id by account id.
   *
   * @param {number|string} accountId - Account id
   * @returns {number} Shard id
   */
  calcShardIdByAccountId(accountId) {
    const aid = Number(accountId);
    const shardCount = Number(this.ctx.app.config.sharding.shardCount);

    if (!Number.isInteger(aid) || aid <= 0) {
      const err = new Error('accountId must be a positive integer');
      err.status = 400;
      throw err;
    }

    if (!Number.isInteger(shardCount) || shardCount <= 0) {
      const err = new Error('invalid shardCount');
      err.status = 500;
      throw err;
    }

    return aid % shardCount;
  }

  /**
   * Get shard pool by shard id.
   *
   * @param {number|string} shardId - Shard id
   * @returns {*} PostgreSQL pool
   */
  getShardPg(shardId) {
    const sid = Number(shardId);

    if (!Number.isInteger(sid) || sid < 0) {
      const err = new Error('shardId must be a non-negative integer');
      err.status = 400;
      throw err;
    }

    const shardPg = this.ctx.app.shardPgMap[sid];

    if (!shardPg) {
      const err = new Error(`shard DB not found: ${sid}`);
      err.status = 500;
      throw err;
    }

    return shardPg;
  }

  /**
   * Get shard id from meta db by account id.
   *
   * @param {number|string} accountId - Account id
   * @returns {Promise<number|null>} Shard id or null
   */
  async getShardIdByAccountId(accountId) {
    const aid = Number(accountId);

    if (!Number.isInteger(aid) || aid <= 0) {
      const err = new Error('accountId must be a positive integer');
      err.status = 400;
      throw err;
    }

    const sql = `
      SELECT shard_id
      FROM account_shards
      WHERE account_id = $1
      LIMIT 1
    `;

    const result = await this.metaPg.query(sql, [ aid ]);
    const row = result.rows[0];

    if (!row) {
      return null;
    }

    return Number(row.shard_id);
  }

  /**
   * Create account.
   *
   * @param {object} [params={}] - Account params
   * @param {number|string} params.userId - User id
   * @param {number|string} [params.initialBalance] - Initial balance
   * @param {number|string} [params.balance] - Balance fallback
   * @returns {Promise<object>} Created account
   */
  async create({ userId, initialBalance, balance } = {}) {
    const uid = Number(userId);
    const bal = initialBalance !== undefined
      ? Number(initialBalance)
      : Number(balance ?? 0);

    if (!Number.isInteger(uid) || uid <= 0) {
      const err = new Error('userId must be a positive integer');
      err.status = 400;
      throw err;
    }

    if (!Number.isFinite(bal) || bal < 0) {
      const err = new Error('balance must be a number >= 0');
      err.status = 400;
      throw err;
    }

    const intBal = Math.floor(bal);

    if (!Number.isSafeInteger(intBal)) {
      const err = new Error('balance is too large');
      err.status = 400;
      throw err;
    }

    const idSql = 'SELECT nextval(\'global_account_id_seq\') AS account_id';
    const idResult = await this.metaPg.query(idSql);
    const accountId = Number(idResult.rows[0].account_id);

    const shardId = this.calcShardIdByAccountId(accountId);
    const shardPg = this.getShardPg(shardId);

    const metaClient = await this.metaPg.connect();
    const shardClient = await shardPg.connect();

    let routingInserted = false;

    try {
      await metaClient.query('BEGIN');

      const routingSql = `
        INSERT INTO account_shards (account_id, shard_id)
        VALUES ($1, $2)
      `;

      await metaClient.query(routingSql, [ accountId, shardId ]);
      await metaClient.query('COMMIT');
      routingInserted = true;

      await shardClient.query('BEGIN');

      const accountSql = `
        INSERT INTO accounts (
          id,
          user_id,
          balance,
          available_balance,
          reserved_balance
        )
        VALUES ($1, $2, $3, $3, 0)
        RETURNING
          id,
          user_id,
          balance,
          available_balance AS "availableBalance",
          reserved_balance AS "reservedBalance",
          (available_balance + reserved_balance) AS "totalBalance",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `;

      const accountResult = await shardClient.query(accountSql, [
        accountId,
        uid,
        intBal,
      ]);

      await shardClient.query('COMMIT');

      return accountResult.rows[0];
    } catch (err) {
      try {
        await metaClient.query('ROLLBACK');
      } catch (_rollbackErr) {
        void _rollbackErr;
      }

      try {
        await shardClient.query('ROLLBACK');
      } catch (_rollbackErr) {
        void _rollbackErr;
      }

      if (routingInserted) {
        try {
          await this.metaPg.query(
            'DELETE FROM account_shards WHERE account_id = $1',
            [ accountId ]
          );
        } catch (_cleanupErr) {
          void _cleanupErr;
        }
      }

      throw err;
    } finally {
      metaClient.release();
      shardClient.release();
    }
  }

  /**
   * Get account by id.
   *
   * @param {number|string} id - Account id
   * @returns {Promise<object|null>} Account or null
   */
  async getById(id) {
    const accountId = Number(id);

    if (!Number.isInteger(accountId) || accountId <= 0) {
      const err = new Error('id must be a positive integer');
      err.status = 400;
      throw err;
    }

    const shardId = this.calcShardIdByAccountId(accountId);
    const shardPg = this.getShardPg(shardId);

    const sql = `
      SELECT
        id,
        user_id,
        balance,
        available_balance AS "availableBalance",
        reserved_balance AS "reservedBalance",
        (available_balance + reserved_balance) AS "totalBalance",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM accounts
      WHERE id = $1
    `;

    const result = await shardPg.query(sql, [ accountId ]);
    return result.rows[0] || null;
  }

  /**
   * List transfers by account id.
   *
   * @param {number|string} accountId - Account id
   * @param {number|string} [limit=50] - Row limit
   * @returns {Promise<object[]>} Transfer rows
   */
  async listTransfersByAccountId(accountId, limit = 50) {
    const aid = Number(accountId);
    const rowLimit = Number(limit);

    if (!Number.isInteger(aid) || aid <= 0) {
      const err = new Error('accountId must be a positive integer');
      err.status = 400;
      throw err;
    }

    if (!Number.isInteger(rowLimit) || rowLimit <= 0) {
      const err = new Error('limit must be a positive integer');
      err.status = 400;
      throw err;
    }

    const shardId = this.calcShardIdByAccountId(aid);
    const shardPg = this.getShardPg(shardId);

    const accountExistsResult = await shardPg.query(
      `
        SELECT id
        FROM accounts
        WHERE id = $1
        LIMIT 1
      `,
      [ aid ]
    );

    if (accountExistsResult.rowCount === 0) {
      const err = new Error('account not found');
      err.status = 404;
      throw err;
    }

    const sql = `
      SELECT
        id,
        from_account_id AS "fromId",
        to_account_id AS "toId",
        amount,
        status,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM transfers
      WHERE from_account_id = $1
         OR to_account_id = $1
      ORDER BY id DESC
      LIMIT $2
    `;

    const result = await shardPg.query(sql, [ aid, rowLimit ]);
    return result.rows;
  }

  /**
   * Route transfer by shard type.
   *
   * @param {number|string} fromId - Source account id
   * @param {number|string} toId - Destination account id
   * @param {number|string} amount - Transfer amount
   * @returns {Promise<object>} Transfer result
   */
  async transfer(fromId, toId, amount) {
    const fromAccountId = Number(fromId);
    const toAccountId = Number(toId);
    const transferAmount = Number(amount);

    if (!Number.isInteger(fromAccountId) || !Number.isInteger(toAccountId)) {
      const err = new Error('fromId/toId must be integer');
      err.status = 400;
      throw err;
    }

    if (!Number.isInteger(transferAmount) || transferAmount <= 0) {
      const err = new Error('amount must be positive integer');
      err.status = 400;
      throw err;
    }

    if (fromAccountId === toAccountId) {
      const err = new Error('fromId and toId must be different');
      err.status = 400;
      throw err;
    }

    const fromShardId = this.calcShardIdByAccountId(fromAccountId);
    const toShardId = this.calcShardIdByAccountId(toAccountId);

    if (fromShardId === toShardId) {
      return await this.transferSameShard({
        fromAccountId,
        toAccountId,
        transferAmount,
        shardId: fromShardId,
      });
    }

    return await this.transferCrossShard({
      fromAccountId,
      toAccountId,
      transferAmount,
      fromShardId,
      toShardId,
    });
  }

  /**
   * Same-shard transfer fast path.
   *
   * @param {object} params - Transfer params
   * @param {number} params.fromAccountId - Source account id
   * @param {number} params.toAccountId - Destination account id
   * @param {number} params.transferAmount - Amount
   * @param {number} params.shardId - Shard id
   * @returns {Promise<object>} Transfer result
   */
  async transferSameShard({
    fromAccountId,
    toAccountId,
    transferAmount,
    shardId,
  }) {
    const shardPg = this.getShardPg(shardId);
    const client = await shardPg.connect();

    try {
      await client.query('BEGIN');

      const debitResult = await client.query(
        `
          UPDATE accounts
          SET
            available_balance = available_balance - $1,
            balance = balance - $1,
            updated_at = NOW()
          WHERE id = $2
            AND available_balance >= $1
          RETURNING id
        `,
        [ transferAmount, fromAccountId ]
      );

      if (debitResult.rowCount === 0) {
        const err = new Error('insufficient funds');
        err.status = 409;
        throw err;
      }

      const creditResult = await client.query(
        `
          UPDATE accounts
          SET
            available_balance = available_balance + $1,
            balance = balance + $1,
            updated_at = NOW()
          WHERE id = $2
          RETURNING id
        `,
        [ transferAmount, toAccountId ]
      );

      if (creditResult.rowCount === 0) {
        const err = new Error(`account not found: ${toAccountId}`);
        err.status = 404;
        throw err;
      }

      await client.query('COMMIT');

      return {
        transferId: null,
        fromId: fromAccountId,
        toId: toAccountId,
        amount: transferAmount,
        status: 'COMPLETED',
        shardId,
        type: 'same-shard',
      };
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (_rollbackErr) {
        void _rollbackErr;
      }

      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Cross-shard transfer.
   *
   * Flow:
   * 1. reserve funds on source shard
   * 2. credit destination shard
   * 3. finalize source shard
   *
   * @param {object} params - Transfer params
   * @param {number} params.fromAccountId - Source account id
   * @param {number} params.toAccountId - Destination account id
   * @param {number} params.transferAmount - Amount
   * @param {number} params.fromShardId - Source shard id
   * @param {number} params.toShardId - Destination shard id
   * @returns {Promise<object>} Transfer result
   */
  async transferCrossShard({
    fromAccountId,
    toAccountId,
    transferAmount,
    fromShardId,
    toShardId,
  }) {
    const fromShardPg = this.getShardPg(fromShardId);
    const toShardPg = this.getShardPg(toShardId);

    const fromClient = await fromShardPg.connect();
    const toClient = await toShardPg.connect();

    let transferId = null;

    try {
      // Step 1: reserve funds on source shard
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
        const err = new Error('insufficient funds or account not found');
        err.status = 409;
        throw err;
      }

      const transferInsert = await fromClient.query(
        `
          INSERT INTO transfers (
            from_account_id,
            to_account_id,
            amount,
            status,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, 'RESERVED', NOW(), NOW())
          RETURNING id
        `,
        [ fromAccountId, toAccountId, transferAmount ]
      );

      transferId = transferInsert.rows[0].id;

      await fromClient.query('COMMIT');

      // Step 2: credit destination shard
      await toClient.query('BEGIN');
      await toClient.query("SET LOCAL lock_timeout = '200ms'");

      const creditResult = await toClient.query(
        `
          UPDATE accounts
          SET
            available_balance = available_balance + $1,
            balance = balance + $1,
            updated_at = NOW()
          WHERE id = $2
          RETURNING id
        `,
        [ transferAmount, toAccountId ]
      );

      if (creditResult.rowCount === 0) {
        const err = new Error('destination account not found');
        err.status = 404;
        throw err;
      }

      await toClient.query('COMMIT');

      // Step 3: finalize source shard
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
          RETURNING id
        `,
        [ transferAmount, fromAccountId ]
      );

      if (finalizeResult.rowCount === 0) {
        const err = new Error('finalize reserved funds failed');
        err.status = 500;
        throw err;
      }

      const completeResult = await fromClient.query(
        `
          UPDATE transfers
          SET
            status = 'COMPLETED',
            updated_at = NOW()
          WHERE id = $1
            AND status = 'RESERVED'
          RETURNING id
        `,
        [ transferId ]
      );

      if (completeResult.rowCount === 0) {
        const err = new Error('mark completed failed');
        err.status = 500;
        throw err;
      }

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
      };
    } catch (err) {
      try {
        await fromClient.query('ROLLBACK');
      } catch (_rollbackErr) {
        void _rollbackErr;
      }

      try {
        await toClient.query('ROLLBACK');
      } catch (_rollbackErr) {
        void _rollbackErr;
      }

      // reserve succeeded, but destination not yet credited
      if (transferId) {
        try {
          await fromClient.query('BEGIN');
          await fromClient.query("SET LOCAL lock_timeout = '200ms'");

          const compensateResult = await fromClient.query(
            `
              UPDATE accounts
              SET
                available_balance = available_balance + $1,
                reserved_balance = reserved_balance - $1,
                updated_at = NOW()
              WHERE id = $2
                AND reserved_balance >= $1
              RETURNING id
            `,
            [ transferAmount, fromAccountId ]
          );

          if (compensateResult.rowCount === 0) {
            const compensateErr = new Error('release reserved funds failed');
            compensateErr.status = 500;
            throw compensateErr;
          }

          const failResult = await fromClient.query(
            `
              UPDATE transfers
              SET
                status = 'FAILED',
                updated_at = NOW()
              WHERE id = $1
                AND status = 'RESERVED'
              RETURNING id
            `,
            [ transferId ]
          );

          if (failResult.rowCount === 0) {
            const compensateErr = new Error('mark failed after reserve rollback failed');
            compensateErr.status = 500;
            throw compensateErr;
          }

          await fromClient.query('COMMIT');
        } catch (_compensateErr) {
          void _compensateErr;

          try {
            await fromClient.query('ROLLBACK');
          } catch (_rollbackErr) {
            void _rollbackErr;
          }
        }
      }

      throw err;
    } finally {
      fromClient.release();
      toClient.release();
    }
  }

}

module.exports = AccountsRepo;
