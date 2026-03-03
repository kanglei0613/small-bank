'use strict';

const { getPool } = require('./pg');

class AccountRepo {
  constructor(app) {
    this.app = app;
    this.pool = getPool(app.config.pg);
  }

  // 建立帳戶：相容 initialBalance / balance（預設 0）
  async create({ initialBalance, balance } = {}) {
    const bal = (initialBalance !== undefined)
      ? Number(initialBalance)
      : Number(balance ?? 0);

    if (!Number.isFinite(bal) || bal < 0) {
      const err = new Error('balance must be a number >= 0');
      err.status = 400;
      throw err;
    }

    // accounts.balance 是 BIGINT：先用整數，避免小數進 DB
    const intBal = Math.floor(bal);
    if (!Number.isSafeInteger(intBal)) {
      const err = new Error('balance is too large');
      err.status = 400;
      throw err;
    }

    const res = await this.pool.query(
      'INSERT INTO accounts(balance) VALUES ($1) RETURNING id, balance, created_at, updated_at',
      [ intBal ]
    );
    return res.rows[0];
  }

  // 取得帳戶
  async getById(id) {
    const accountId = Number(id);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      const err = new Error('id must be a positive integer');
      err.status = 400;
      throw err;
    }

    const res = await this.pool.query(
      'SELECT id, balance, created_at, updated_at FROM accounts WHERE id = $1',
      [ accountId ]
    );
    return res.rows[0] || null;
  }

  // 核心：transaction + row lock + 固定鎖順序避免死鎖
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

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const a = Math.min(fromId, toId);
      const b = Math.max(fromId, toId);

      // 先鎖 id 小的，再鎖 id 大的（避免兩筆互轉死鎖）
      const lockA = await client.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [ a ]);
      if (lockA.rowCount === 0) {
        const err = new Error(`account not found: ${a}`);
        err.status = 404;
        throw err;
      }

      const lockB = await client.query('SELECT id FROM accounts WHERE id=$1 FOR UPDATE', [ b ]);
      if (lockB.rowCount === 0) {
        const err = new Error(`account not found: ${b}`);
        err.status = 404;
        throw err;
      }

      // 檢查 fromId 餘額
      const fromRes = await client.query('SELECT balance FROM accounts WHERE id=$1', [ fromId ]);
      const fromBal = BigInt(fromRes.rows[0].balance);
      const amt = BigInt(amount);

      if (fromBal < amt) {
        const err = new Error('insufficient funds');
        err.status = 409;
        throw err;
      }

      // 更新（用 balance = balance +/- amount）
      await client.query('UPDATE accounts SET balance = balance - $1 WHERE id = $2', [ amount, fromId ]);
      await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [ amount, toId ]);
      await client.query(
        `INSERT INTO transfers (from_account_id, to_account_id, amount)
         VALUES ($1, $2, $3)`,
        [ fromId, toId, amount ]
      );

      await client.query('COMMIT');
      return { ok: true };
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        this.app.logger.error('Rollback failed:', rollbackErr);
      }
      throw e;
    } finally {
      client.release();
    }
  }
}

module.exports = AccountRepo;
