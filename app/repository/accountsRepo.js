'use strict';

class AccountsRepo {
  constructor(ctx) {
    this.ctx = ctx;

    // meta DB
    this.metaPg = ctx.app.metaPg;
  }

  // 依 accountId 計算 shardId
  calcShardIdByAccountId(accountId) {
    const aid = Number(accountId);
    const shardCount = Number(this.ctx.app.config.sharding.shardCount);

    // 檢查 accountId
    if (!Number.isInteger(aid) || aid <= 0) {
      const err = new Error('accountId must be a positive integer');
      err.status = 400;
      throw err;
    }

    // 檢查 shardCount
    if (!Number.isInteger(shardCount) || shardCount <= 0) {
      const err = new Error('invalid shardCount');
      err.status = 500;
      throw err;
    }

    return aid % shardCount;
  }

  // 依 shardId 取得對應 shard pool
  getShardPg(shardId) {
    const sid = Number(shardId);

    // 檢查 shardId
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

  // 依 accountId 查詢 shardId
  async getShardIdByAccountId(accountId) {
    const aid = Number(accountId);

    // 檢查 accountId
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

  // 建立帳戶
  async create({ userId, initialBalance, balance } = {}) {
    const uid = Number(userId);
    const bal = (initialBalance !== undefined)
      ? Number(initialBalance)
      : Number(balance ?? 0);

    // 檢查 userId
    if (!Number.isInteger(uid) || uid <= 0) {
      const err = new Error('userId must be a positive integer');
      err.status = 400;
      throw err;
    }

    // 檢查 balance
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

    // 先從 meta DB 取得全域 accountId
    const idSql = 'SELECT nextval(\'global_account_id_seq\') AS account_id';
    const idResult = await this.metaPg.query(idSql);
    const accountId = Number(idResult.rows[0].account_id);

    // 計算 shardId
    const shardId = this.calcShardIdByAccountId(accountId);
    const shardPg = this.getShardPg(shardId);

    const metaClient = await this.metaPg.connect();
    const shardClient = await shardPg.connect();

    let routingInserted = false;

    try {
      // 先寫 meta routing
      await metaClient.query('BEGIN');

      const routingSql = `
        INSERT INTO account_shards (account_id, shard_id)
        VALUES ($1, $2)
      `;

      await metaClient.query(routingSql, [ accountId, shardId ]);
      await metaClient.query('COMMIT');
      routingInserted = true;

      // 再寫 shard accounts
      await shardClient.query('BEGIN');

      const accountSql = `
        INSERT INTO accounts (id, user_id, balance)
        VALUES ($1, $2, $3)
        RETURNING id, user_id, balance, created_at, updated_at
      `;

      const accountResult = await shardClient.query(accountSql, [
        accountId,
        uid,
        intBal,
      ]);

      await shardClient.query('COMMIT');

      return accountResult.rows[0];
    } catch (err) {
      this.ctx.app.logger.error('create account error:', err.message, err.code);

      try {
        await metaClient.query('ROLLBACK');
      } catch (rollbackErr) {
        this.ctx.app.logger.error('Meta rollback failed:', rollbackErr);
      }

      try {
        await shardClient.query('ROLLBACK');
      } catch (rollbackErr) {
        this.ctx.app.logger.error('Shard rollback failed:', rollbackErr);
      }

      // 如果 meta 已經寫成功，但 shard 寫失敗，補刪 routing
      if (routingInserted) {
        try {
          await this.metaPg.query(
            'DELETE FROM account_shards WHERE account_id = $1',
            [ accountId ]
          );
        } catch (cleanupErr) {
          this.ctx.app.logger.error('Meta cleanup failed:', cleanupErr);
        }
      }

      throw err;
    } finally {
      metaClient.release();
      shardClient.release();
    }
  }

  // 依 id 查詢帳戶
  async getById(id) {
    const accountId = Number(id);

    // 檢查 id
    if (!Number.isInteger(accountId) || accountId <= 0) {
      const err = new Error('id must be a positive integer');
      err.status = 400;
      throw err;
    }

    // 先查 account 所在 shard
    const shardId = await this.getShardIdByAccountId(accountId);
    if (shardId === null) {
      return null;
    }

    const shardPg = this.getShardPg(shardId);

    // 到對應 shard 查詢帳戶
    const sql = `
      SELECT id, user_id, balance, created_at, updated_at
      FROM accounts
      WHERE id = $1
    `;

    const result = await shardPg.query(sql, [ accountId ]);
    return result.rows[0] || null;
  }

  // 依 accountId 查詢交易紀錄
  async listTransfersByAccountId(accountId, limit = 50) {
    const aid = Number(accountId);
    const rowLimit = Number(limit);

    // 檢查 accountId
    if (!Number.isInteger(aid) || aid <= 0) {
      const err = new Error('accountId must be a positive integer');
      err.status = 400;
      throw err;
    }

    // 檢查 limit
    if (!Number.isInteger(rowLimit) || rowLimit <= 0) {
      const err = new Error('limit must be a positive integer');
      err.status = 400;
      throw err;
    }

    // 先查 account 所在 shard
    const shardId = await this.getShardIdByAccountId(aid);
    if (shardId === null) {
      const err = new Error('account not found');
      err.status = 404;
      throw err;
    }

    const shardPg = this.getShardPg(shardId);

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

    const result = await shardPg.query(sql, [ aid, rowLimit ]);
    return result.rows;
  }

  // 轉帳
  // 目前只支援 same-shard transfer
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

    // 先查 from / to 各自所在 shard
    const fromShardId = await this.getShardIdByAccountId(fromAccountId);
    const toShardId = await this.getShardIdByAccountId(toAccountId);

    if (fromShardId === null) {
      const err = new Error(`account not found: ${fromAccountId}`);
      err.status = 404;
      throw err;
    }

    if (toShardId === null) {
      const err = new Error(`account not found: ${toAccountId}`);
      err.status = 404;
      throw err;
    }

    // 目前先只支援 same-shard transfer
    if (fromShardId !== toShardId) {
      const err = new Error('cross-shard transfer not supported yet');
      err.status = 501;
      throw err;
    }

    const shardPg = this.getShardPg(fromShardId);

    // 從 shard pool 取得 connection
    const client = await shardPg.connect();

    try {
      // 開始 transaction
      await client.query('BEGIN');

      // 在 transaction 內設定 lock timeout
      await client.query("SET LOCAL lock_timeout = '200ms'");

      // 固定鎖順序，避免 deadlock
      const a = Math.min(fromAccountId, toAccountId);
      const b = Math.max(fromAccountId, toAccountId);

      // 鎖住兩筆 account row
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

      // 寫入 transfer record
      const transferResult = await client.query(
        `
          INSERT INTO transfers (from_account_id, to_account_id, amount)
          VALUES ($1, $2, $3)
          RETURNING id, from_account_id, to_account_id, amount, created_at
        `,
        [ fromAccountId, toAccountId, transferAmount ]
      );

      // 提交 transaction
      await client.query('COMMIT');

      return {
        transferId: transferResult.rows[0].id,
        fromId: fromAccountId,
        toId: toAccountId,
        amount: transferAmount,
        createdAt: transferResult.rows[0].created_at,
        shardId: fromShardId,
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
      // 歸還 connection
      client.release();
    }
  }
}

module.exports = AccountsRepo;
