'use strict';

class AccountsRepo {
  constructor(ctx) {
    this.ctx = ctx;

    // 取得PostgreSQL connection pool
    this.pg = ctx.app.pg;
  }

  // 建立帳戶
  async create({ userId, initialBalance, balance } = {}) {
    const uid = Number(userId);
    const bal = (initialBalance !== undefined)
      ? Number(initialBalance)
      : Number(balance ?? 0);

    // 檢查userId
    if (!Number.isInteger(uid) || uid <= 0) {
      const err = new Error('userId must be a positive integer');
      err.status = 400;
      throw err;
    }

    // 檢查balance
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

    // 新增帳戶並回傳資料
    const sql = `
      INSERT INTO accounts (user_id, balance)
      VALUES ($1, $2)
      RETURNING id, user_id, balance, created_at, updated_at
    `;

    const result = await this.pg.query(sql, [ uid, intBal ]);
    return result.rows[0];
  }

  // 依id查詢帳戶
  async getById(id) {
    const accountId = Number(id);

    // 檢查id
    if (!Number.isInteger(accountId) || accountId <= 0) {
      const err = new Error('id must be a positive integer');
      err.status = 400;
      throw err;
    }

    // 查詢帳戶
    const sql = `
      SELECT id, user_id, balance, created_at, updated_at
      FROM accounts
      WHERE id = $1
    `;

    const result = await this.pg.query(sql, [ accountId ]);
    return result.rows[0] || null;
  }
  // 依 accountId 查詢交易紀錄
  async listTransfersByAccountId(accountId, limit = 50) {
    const sql = `
      SELECT
        id,
        from_account_id AS "fromId",
        to_account_id AS "toId",
        amount,
        created_at
      FROM transfers
      WHERE from_account_id = $1
         OR to_account_id = $1
      ORDER BY id DESC
      LIMIT $2
    `;

    const result = await this.pg.query(sql, [ accountId, limit ]);
    return result.rows;
  }

  // 轉帳
  async transfer(fromId, toId, amount) {
    const fromAccountId = Number(fromId);
    const toAccountId = Number(toId);
    const transferAmount = Number(amount);

    // 檢查參數
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

    // 從pool取得connection
    const client = await this.pg.connect();

    try {
      // 開始transaction
      await client.query('BEGIN');

      // 在 transaction 內設定 lock timeout
      await client.query("SET LOCAL lock_timeout = '200ms'");

      // 固定鎖順序，避免deadlock
      const a = Math.min(fromAccountId, toAccountId);
      const b = Math.max(fromAccountId, toAccountId);

      // 鎖住兩筆account row
      const locked = await client.query(
        `
          SELECT id
          FROM accounts
          WHERE id = ANY($1::bigint[])
          ORDER BY id
          FOR UPDATE
        `,
        [[ a, b ]]
      );

      // 檢查帳戶是否存在
      if (locked.rowCount !== 2) {
        const found = new Set(locked.rows.map(r => Number(r.id)));
        const missing = !found.has(a) ? a : b;
        const err = new Error(`account not found: ${missing}`);
        err.status = 404;
        throw err;
      }

      // 扣款，並檢查不能透支
      const debit = await client.query(
        `
          UPDATE accounts
          SET balance = balance - $1,
              updated_at = NOW()
          WHERE id = $2
            AND balance >= $1
          RETURNING balance
        `,
        [ transferAmount, fromAccountId ]
      );

      if (debit.rowCount === 0) {
        const err = new Error('insufficient funds');
        err.status = 409;
        throw err;
      }

      // 加款
      await client.query(
        `
          UPDATE accounts
          SET balance = balance + $1,
              updated_at = NOW()
          WHERE id = $2
        `,
        [ transferAmount, toAccountId ]
      );

      // 寫入transfer record
      const transferResult = await client.query(
        `
          INSERT INTO transfers (from_account_id, to_account_id, amount)
          VALUES ($1, $2, $3)
          RETURNING id, from_account_id, to_account_id, amount, created_at
        `,
        [ fromAccountId, toAccountId, transferAmount ]
      );

      // 提交transaction
      await client.query('COMMIT');

      return {
        transferId: transferResult.rows[0].id,
        fromId: fromAccountId,
        toId: toAccountId,
        amount: transferAmount,
        createdAt: transferResult.rows[0].created_at,
      };
    } catch (err) {
      this.ctx.app.logger.error('transfer error:', err.message, err.code);

      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        this.ctx.app.logger.error('Rollback failed:', rollbackErr);
      }

      throw err;
    } finally {
      // 歸還connection
      client.release();
    }
  }
}

module.exports = AccountsRepo;
