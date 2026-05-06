'use strict';

/**
 * @file app/repository/accountsRepo.js
 *
 * 帳號資料存取層（AccountsRepo）
 *
 * 職責：
 * - create：從 meta DB 取得全局唯一 accountId → 計算 shardId → 同時寫入 meta DB
 *   的 account_shards 路由表與 shard DB 的 accounts 表（兩個獨立 transaction）
 * - getById：依 accountId 計算 shardId，直接查對應 shard 取得帳號資料
 * - deposit：對 shard DB 開 transaction，增加 balance 與 available_balance
 * - withdraw：對 shard DB 開 transaction，加上 available_balance >= amount 條件確保不超支
 *
 * 開戶失敗補償：
 * - 若 shard 寫入失敗，清除已插入的 account_shards 路由記錄，保持 meta 資料一致性
 */

const BaseShardRepo = require('./baseShardRepo');

class AccountsRepo extends BaseShardRepo {

  /**
   * 開戶：從 meta DB 取得全局唯一 accountId，計算 shardId 後同時寫入
   * meta DB 的路由表（account_shards）與對應 shard 的 accounts 表。
   * 若 shard 寫入失敗，自動清除 meta DB 的路由記錄以保持一致性。
   * @param {{ userId: number, initialBalance: number }} params
   * @returns {object} 新建帳號資料（含 id, userId, balance 等欄位）
   */
  async create({ userId, initialBalance } = {}) {
    const uid = Number(userId);
    const bal = Math.floor(Number(initialBalance || 0));

    const idResult = await this.metaPg.query(
      "SELECT nextval('global_account_id_seq') AS account_id"
    );
    const accountId = Number(idResult.rows[0].account_id);
    const shardId = this.calcShardId(accountId);
    const shardPg = this.getShardPg(shardId);

    const metaClient = await this.metaPg.connect();
    const shardClient = await shardPg.connect();
    let routingInserted = false;

    try {
      await metaClient.query('BEGIN');
      await metaClient.query(
        'INSERT INTO account_shards (account_id, shard_id) VALUES ($1, $2)',
        [ accountId, shardId ]
      );
      await metaClient.query('COMMIT');

      routingInserted = true;

      await shardClient.query('BEGIN');

      const result = await shardClient.query(
        `
          INSERT INTO accounts (id, user_id, balance, available_balance, reserved_balance)
          VALUES ($1, $2, $3, $3, 0)
          RETURNING
            id,
            user_id AS "userId",
            balance,
            available_balance AS "availableBalance",
            reserved_balance AS "reservedBalance",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
        `,
        [ accountId, uid, bal ]
      );

      await shardClient.query('COMMIT');

      return result.rows[0];
    } catch (err) {
      try { await metaClient.query('ROLLBACK'); } catch (e) { void e; }
      try { await shardClient.query('ROLLBACK'); } catch (e) { void e; }

      if (routingInserted) {
        try {
          await this.metaPg.query(
            'DELETE FROM account_shards WHERE account_id = $1',
            [ accountId ]
          );
        } catch (e) { void e; }
      }

      throw err;
    } finally {
      metaClient.release();
      shardClient.release();
    }
  }

  /**
   * 依 accountId 查詢帳號資料（balance、availableBalance、reservedBalance）
   * @param {number|string} id - accountId
   * @returns {object|null} 帳號資料，找不到時回傳 null
   */
  async getById(id) {
    const accountId = Number(id);
    const shardPg = this.getShardPg(this.calcShardId(accountId));

    const result = await shardPg.query(
      `
        SELECT
          id,
          user_id AS "userId",
          balance,
          available_balance AS "availableBalance",
          reserved_balance AS "reservedBalance",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM accounts
        WHERE id = $1
      `,
      [ accountId ]
    );

    return result.rows[0] || null;
  }

  /**
   * 存款：在 transaction 內增加 balance 與 available_balance
   * @param {{ accountId: number, amount: number }} params
   * @returns {{ type, accountId, amount, account }} 更新後的帳號餘額
   */
  async deposit({ accountId, amount }) {
    const aid = Number(accountId);
    const amt = Number(amount);
    const shardPg = this.getShardPg(this.calcShardId(aid));
    const client = await shardPg.connect();

    try {
      await client.query('BEGIN');

      const result = await client.query(
        `
          UPDATE accounts
          SET
            balance = balance + $1,
            available_balance = available_balance + $1,
            updated_at = NOW()
          WHERE id = $2
          RETURNING
            id,
            balance,
            available_balance AS "availableBalance",
            reserved_balance AS "reservedBalance",
            updated_at AS "updatedAt"
        `,
        [ amt, aid ]
      );

      if (result.rowCount === 0) {
        const { NotFoundError } = require('../lib/errors');
        throw new NotFoundError('account not found');
      }

      await client.query('COMMIT');

      return { type: 'deposit', accountId: aid, amount: amt, account: result.rows[0] };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (e) { void e; }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * 提款：在 transaction 內扣減 balance 與 available_balance
   * 使用 WHERE available_balance >= amount 確保餘額不足時不執行扣款
   * rowCount === 0 時進一步區分「帳號不存在」或「餘額不足」並拋出對應錯誤
   * @param {{ accountId: number, amount: number }} params
   * @returns {{ type, accountId, amount, account }} 更新後的帳號餘額
   */
  async withdraw({ accountId, amount }) {
    const aid = Number(accountId);
    const amt = Number(amount);
    const shardPg = this.getShardPg(this.calcShardId(aid));
    const client = await shardPg.connect();

    try {
      await client.query('BEGIN');

      const result = await client.query(
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
        [ amt, aid ]
      );

      if (result.rowCount === 0) {
        const existsResult = await client.query(
          'SELECT id FROM accounts WHERE id = $1 LIMIT 1',
          [ aid ]
        );
        const { NotFoundError, ConflictError } = require('../lib/errors');
        if (existsResult.rowCount === 0) throw new NotFoundError('account not found');
        throw new ConflictError('insufficient funds');
      }

      await client.query('COMMIT');

      return { type: 'withdraw', accountId: aid, amount: amt, account: result.rows[0] };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (e) { void e; }
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = AccountsRepo;
