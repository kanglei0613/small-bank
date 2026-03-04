'use strict';

const ShardRouterRepo = require('./shardRouterRepo');

class AccountRepo {
  constructor(app) {
    this.app = app;
    this.router = new ShardRouterRepo(app);
  }

  async create({ initialBalance, balance } = {}) {
    const bal = (initialBalance !== undefined)
      ? Number(initialBalance)
      : Number(balance ?? 0);

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

    const { accountId, shardId } = await this.router.allocateAccountIdAndShard();
    const shardPool = this.router.getShardPool(shardId);

    await shardPool.query(
      'INSERT INTO accounts(id, balance) VALUES ($1, $2)',
      [ accountId, intBal ]
    );

    await this.router.registerAccountShard(accountId, shardId);

    const res = await shardPool.query(
      'SELECT id, balance, created_at, updated_at FROM accounts WHERE id = $1',
      [ accountId ]
    );
    return res.rows[0];
  }

  async getById(id) {
    const accountId = Number(id);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      const err = new Error('id must be a positive integer');
      err.status = 400;
      throw err;
    }

    const shardId = await this.router.getShardIdByAccountId(accountId);
    if (shardId === null) return null;

    const shardPool = this.router.getShardPool(shardId);
    const res = await shardPool.query(
      'SELECT id, balance, created_at, updated_at FROM accounts WHERE id = $1',
      [ accountId ]
    );
    return res.rows[0] || null;
  }

  // 分片轉帳：只支援同 shard 內
  async transfer(fromId, toId, amount) {
    if (!Number.isInteger(fromId) || !Number.isInteger(toId)) {
      const err = new Error('fromId/toId must be integer');
      err.status = 400;
      throw err;
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      const err = new Error('amount must be positive integer');
      err.status = 400;
      throw err;
    }
    if (fromId === toId) {
      const err = new Error('fromId and toId must be different');
      err.status = 400;
      throw err;
    }

    const fromShard = await this.router.getShardIdByAccountId(fromId);
    const toShard = await this.router.getShardIdByAccountId(toId);

    if (fromShard === null) {
      const err = new Error(`account not found: ${fromId}`);
      err.status = 404;
      throw err;
    }
    if (toShard === null) {
      const err = new Error(`account not found: ${toId}`);
      err.status = 404;
      throw err;
    }

    if (fromShard !== toShard) {
      const err = new Error('cross-shard transfer not supported');
      err.status = 501;
      throw err;
    }

    const shardPool = this.router.getShardPool(fromShard);
    const client = await shardPool.connect();

    try {
      await client.query('BEGIN');

      const a = Math.min(fromId, toId);
      const b = Math.max(fromId, toId);

      const locked = await client.query(
        'SELECT id FROM accounts WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE',
        [[ a, b ]]
      );

      if (locked.rowCount !== 2) {
        const found = new Set(locked.rows.map(r => r.id));
        const missing = !found.has(a) ? a : b;
        const err = new Error(`account not found: ${missing}`);
        err.status = 404;
        throw err;
      }

      const debit = await client.query(
        'UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING balance',
        [ amount, fromId ]
      );
      if (debit.rowCount === 0) {
        const err = new Error('insufficient funds');
        err.status = 409;
        throw err;
      }

      await client.query(
        'UPDATE accounts SET balance = balance + $1 WHERE id = $2',
        [ amount, toId ]
      );

      await client.query(
        'INSERT INTO transfers (from_account_id, to_account_id, amount) VALUES ($1, $2, $3)',
        [ fromId, toId, amount ]
      );

      await client.query('COMMIT');
      return { ok: true, shardId: fromShard };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (rollbackErr) {
        this.app.logger.error('Rollback failed:', rollbackErr);
      }
      throw e;
    } finally {
      client.release();
    }
  }
}

module.exports = AccountRepo;
