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

    // 直接依 accountId 計算 shard
    const shardId = this.calcShardIdByAccountId(accountId);
    const shardPg = this.getShardPg(shardId);

    // 到對應 shard 查詢帳戶
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

    // 直接依 accountId 計算 shard
    const shardId = this.calcShardIdByAccountId(aid);
    const shardPg = this.getShardPg(shardId);

    // 先確認帳戶是否存在
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

    // 直接依 accountId 計算 shard
    // 目前 shard routing 規則固定為 accountId % shardCount
    // 因此 transfer hot path 不再額外查 meta DB
    const fromShardId = this.calcShardIdByAccountId(fromAccountId);
    const toShardId = this.calcShardIdByAccountId(toAccountId);

    // same-shard 走單一 transaction
    if (fromShardId === toShardId) {
      return await this.transferSameShard({
        fromAccountId,
        toAccountId,
        transferAmount,
        shardId: fromShardId,
      });
    }

    // cross-shard 走 reserve / credit / finalize
    return await this.transferCrossShard({
      fromAccountId,
      toAccountId,
      transferAmount,
      fromShardId,
      toShardId,
    });
  }

  // same-shard 轉帳
  async transferSameShard({ fromAccountId, toAccountId, transferAmount, shardId }) {
    const shardPg = this.getShardPg(shardId);

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

      // 扣款，檢查 available_balance 是否足夠
      const debit = await client.query(
        `
          UPDATE accounts
          SET available_balance = available_balance - $1,
              balance = balance - $1,
              updated_at = NOW()
          WHERE id = $2
            AND available_balance >= $1
          RETURNING
            id,
            balance,
            available_balance,
            reserved_balance
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
          SET available_balance = available_balance + $1,
              balance = balance + $1,
              updated_at = NOW()
          WHERE id = $2
        `,
        [ transferAmount, toAccountId ]
      );

      // 寫入 transfer record
      const transferResult = await client.query(
        `
          INSERT INTO transfers (
            from_account_id,
            to_account_id,
            amount,
            status,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, 'COMPLETED', NOW(), NOW())
          RETURNING
            id,
            from_account_id,
            to_account_id,
            amount,
            status,
            created_at,
            updated_at
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
        status: transferResult.rows[0].status,
        createdAt: transferResult.rows[0].created_at,
        updatedAt: transferResult.rows[0].updated_at,
        shardId,
        type: 'same-shard',
      };
    } catch (err) {
      this.ctx.app.logger.error('same-shard transfer error:', err.message, err.code);

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

  // cross-shard 轉帳
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
    let credited = false;

    try {
      // Step 1: 在 from shard 預留金額
      await fromClient.query('BEGIN');
      await fromClient.query("SET LOCAL lock_timeout = '200ms'");

      // 鎖住 from account，避免併發下重複扣款
      const fromLocked = await fromClient.query(
        `
          SELECT id
          FROM accounts
          WHERE id = $1
          FOR UPDATE
        `,
        [ fromAccountId ]
      );

      if (fromLocked.rowCount === 0) {
        const err = new Error(`account not found: ${fromAccountId}`);
        err.status = 404;
        throw err;
      }

      // 從 available_balance 移到 reserved_balance
      const reserveResult = await fromClient.query(
        `
          UPDATE accounts
          SET available_balance = available_balance - $1,
              reserved_balance = reserved_balance + $1,
              updated_at = NOW()
          WHERE id = $2
            AND available_balance >= $1
          RETURNING
            id,
            available_balance,
            reserved_balance
        `,
        [ transferAmount, fromAccountId ]
      );

      if (reserveResult.rowCount === 0) {
        const err = new Error('insufficient funds');
        err.status = 409;
        throw err;
      }

      // 在 from shard 寫入 RESERVED transfer record
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
          RETURNING id, created_at, updated_at
        `,
        [ fromAccountId, toAccountId, transferAmount ]
      );

      transferId = transferInsert.rows[0].id;

      await fromClient.query('COMMIT');

      // Step 2: 在 to shard 入帳
      await toClient.query('BEGIN');
      await toClient.query("SET LOCAL lock_timeout = '200ms'");

      // 鎖住 to account
      const toLocked = await toClient.query(
        `
          SELECT id
          FROM accounts
          WHERE id = $1
          FOR UPDATE
        `,
        [ toAccountId ]
      );

      if (toLocked.rowCount === 0) {
        const err = new Error(`account not found: ${toAccountId}`);
        err.status = 404;
        throw err;
      }

      // to shard 增加 available_balance，同步維持舊 balance
      const creditResult = await toClient.query(
        `
          UPDATE accounts
          SET available_balance = available_balance + $1,
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

      await toClient.query('COMMIT');
      credited = true;

      // Step 3: 回 from shard finalize
      // 成功路徑直接從 RESERVED -> COMPLETED
      // 不再額外做一次 CREDITED 中間狀態 transaction
      await fromClient.query('BEGIN');
      await fromClient.query("SET LOCAL lock_timeout = '200ms'");

      // 鎖住 from account
      const finalizeLocked = await fromClient.query(
        `
          SELECT id
          FROM accounts
          WHERE id = $1
          FOR UPDATE
        `,
        [ fromAccountId ]
      );

      if (finalizeLocked.rowCount === 0) {
        const err = new Error(`account not found: ${fromAccountId}`);
        err.status = 404;
        throw err;
      }

      // 正式把 reserved_balance 扣掉，並同步更新舊 balance
      const finalizeResult = await fromClient.query(
        `
          UPDATE accounts
          SET reserved_balance = reserved_balance - $1,
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

      // 直接把 transfer 從 RESERVED 標成 COMPLETED
      const completeResult = await fromClient.query(
        `
          UPDATE transfers
          SET status = 'COMPLETED',
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
      this.ctx.app.logger.error('cross-shard transfer error:', err.message, err.code);

      try {
        await fromClient.query('ROLLBACK');
      } catch (rollbackErr) {
        this.ctx.app.logger.error('From shard rollback failed:', rollbackErr);
      }

      try {
        await toClient.query('ROLLBACK');
      } catch (rollbackErr) {
        this.ctx.app.logger.error('To shard rollback failed:', rollbackErr);
      }

      // reserve 成功但 to shard 尚未入帳，補償回 available_balance
      if (transferId && !credited) {
        try {
          await fromClient.query('BEGIN');

          // 鎖住 from account
          const compensateLocked = await fromClient.query(
            `
              SELECT id
              FROM accounts
              WHERE id = $1
              FOR UPDATE
            `,
            [ fromAccountId ]
          );

          if (compensateLocked.rowCount === 0) {
            const compensateErr = new Error(`account not found: ${fromAccountId}`);
            compensateErr.status = 404;
            throw compensateErr;
          }

          // 釋放 reserved_balance
          const compensateResult = await fromClient.query(
            `
              UPDATE accounts
              SET available_balance = available_balance + $1,
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

          // 更新 transfer 狀態
          const failResult = await fromClient.query(
            `
              UPDATE transfers
              SET status = 'FAILED',
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
        } catch (compensateErr) {
          try {
            await fromClient.query('ROLLBACK');
          } catch (rollbackErr) {
            this.ctx.app.logger.error('Compensate rollback failed:', rollbackErr);
          }

          this.ctx.app.logger.error('cross-shard compensate failed:', compensateErr);
        }
      }

      // to shard 已入帳，但 finalize 失敗
      // 這時不能直接把錢退回，否則可能造成雙方都拿到錢
      // 先把 transfer status 保留在 CREDITED，交由後續修復流程處理
      if (transferId && credited) {
        try {
          await fromClient.query('BEGIN');

          const markCreditedRecoveryResult = await fromClient.query(
            `
              UPDATE transfers
              SET status = 'CREDITED',
                  updated_at = NOW()
              WHERE id = $1
                AND status IN ('RESERVED', 'CREDITED')
              RETURNING id
            `,
            [ transferId ]
          );

          if (markCreditedRecoveryResult.rowCount === 0) {
            const recoveryErr = new Error('mark credited recovery failed');
            recoveryErr.status = 500;
            throw recoveryErr;
          }

          await fromClient.query('COMMIT');
        } catch (recoveryErr) {
          try {
            await fromClient.query('ROLLBACK');
          } catch (rollbackErr) {
            this.ctx.app.logger.error('Credited recovery rollback failed:', rollbackErr);
          }

          this.ctx.app.logger.error('cross-shard credited recovery failed:', recoveryErr);
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
