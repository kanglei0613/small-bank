// repository/accountsRepo.js
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

  // 轉帳（fake benchmark 用，暫時不碰 DB）
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

    return {
      transferId: 1,
      fromId: fromAccountId,
      toId: toAccountId,
      amount: transferAmount,
      status: 'COMPLETED',
      fromShardId,
      toShardId,
      type: fromShardId === toShardId ? 'same-shard' : 'cross-shard',
    };
  }

  // same-shard 轉帳
  async transferSameShard({ fromAccountId, toAccountId, transferAmount, shardId }) {
    const shardPg = this.getShardPg(shardId);
    const client = await shardPg.connect();

    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '200ms'");

      // 固定鎖順序，避免 deadlock
      const a = Math.min(fromAccountId, toAccountId);
      const b = Math.max(fromAccountId, toAccountId);

      // 一次鎖兩筆 row，並把 available_balance 一起帶出來
      const locked = await client.query(
        `
          SELECT id, available_balance
          FROM accounts
          WHERE id = ANY($1::bigint[])
          ORDER BY id
          FOR UPDATE
        `,
        [[ a, b ]]
      );

      if (locked.rowCount !== 2) {
        const found = new Set(locked.rows.map(r => Number(r.id)));
        const missing = !found.has(a) ? a : b;
        const err = new Error(`account not found: ${missing}`);
        err.status = 404;
        throw err;
      }

      const fromRow = locked.rows.find(row => Number(row.id) === fromAccountId);

      if (!fromRow) {
        const err = new Error(`account not found: ${fromAccountId}`);
        err.status = 404;
        throw err;
      }

      if (Number(fromRow.available_balance) < transferAmount) {
        const err = new Error('insufficient funds');
        err.status = 409;
        throw err;
      }

      // 一次更新兩筆帳戶，減少一個 round-trip
      const updateResult = await client.query(
        `
          UPDATE accounts
          SET
            available_balance = CASE
              WHEN id = $2 THEN available_balance - $1
              WHEN id = $3 THEN available_balance + $1
              ELSE available_balance
            END,
            balance = CASE
              WHEN id = $2 THEN balance - $1
              WHEN id = $3 THEN balance + $1
              ELSE balance
            END,
            updated_at = NOW()
          WHERE id = ANY($4::bigint[])
          RETURNING id
        `,
        [
          transferAmount,
          fromAccountId,
          toAccountId,
          [ fromAccountId, toAccountId ],
        ]
      );

      if (updateResult.rowCount !== 2) {
        const err = new Error('same-shard account update failed');
        err.status = 500;
        throw err;
      }

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

      // 直接用 UPDATE 當鎖 + 預留
      const reserveResult = await fromClient.query(
        `
          UPDATE accounts
          SET available_balance = available_balance - $1,
              reserved_balance = reserved_balance + $1,
              updated_at = NOW()
          WHERE id = $2
            AND available_balance >= $1
          RETURNING id
        `,
        [ transferAmount, fromAccountId ]
      );

      if (reserveResult.rowCount === 0) {
        const existsResult = await fromClient.query(
          `
            SELECT 1
            FROM accounts
            WHERE id = $1
            LIMIT 1
          `,
          [ fromAccountId ]
        );

        if (existsResult.rowCount === 0) {
          const err = new Error(`account not found: ${fromAccountId}`);
          err.status = 404;
          throw err;
        }

        const err = new Error('insufficient funds');
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
          RETURNING id, created_at, updated_at
        `,
        [ fromAccountId, toAccountId, transferAmount ]
      );

      transferId = transferInsert.rows[0].id;

      await fromClient.query('COMMIT');

      // Step 2: 在 to shard 入帳
      await toClient.query('BEGIN');
      await toClient.query("SET LOCAL lock_timeout = '200ms'");

      // 直接用 UPDATE 當鎖 + 入帳
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
      await fromClient.query('BEGIN');
      await fromClient.query("SET LOCAL lock_timeout = '200ms'");

      // 直接用 UPDATE 當鎖 + finalize
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
        const existsResult = await fromClient.query(
          `
            SELECT 1
            FROM accounts
            WHERE id = $1
            LIMIT 1
          `,
          [ fromAccountId ]
        );

        if (existsResult.rowCount === 0) {
          const err = new Error(`account not found: ${fromAccountId}`);
          err.status = 404;
          throw err;
        }

        const err = new Error('finalize reserved funds failed');
        err.status = 500;
        throw err;
      }

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
          await fromClient.query("SET LOCAL lock_timeout = '200ms'");

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
            const existsResult = await fromClient.query(
              `
                SELECT 1
                FROM accounts
                WHERE id = $1
                LIMIT 1
              `,
              [ fromAccountId ]
            );

            if (existsResult.rowCount === 0) {
              const compensateErr = new Error(`account not found: ${fromAccountId}`);
              compensateErr.status = 404;
              throw compensateErr;
            }

            const compensateErr = new Error('release reserved funds failed');
            compensateErr.status = 500;
            throw compensateErr;
          }

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
