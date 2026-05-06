'use strict';

/**
 * @file app/repository/usersRepo.js
 *
 * 用戶資料存取層（UsersRepo）
 *
 * 職責：
 * - create：在 meta DB 的 users 表新增用戶
 * - getById：依 userId 從 meta DB 查詢用戶資料
 * - listAccountIdsByUserId：查詢用戶在 meta DB 的所有帳號 ID
 *
 * 注意：
 * - users 與 account_shards 路由表同存於 meta DB，不涉及 shard DB
 */

class UsersRepo {

  constructor(ctx) {
    this.pg = ctx.app.metaPg;
  }

  /**
   * 新增用戶至 meta DB 的 users 表
   * @param {{ name: string }} params
   * @returns {{ id, name, created_at }} 新建用戶資料
   */
  async create({ name }) {
    const result = await this.pg.query(
      `
        INSERT INTO users (name)
        VALUES ($1)
        RETURNING id, name, created_at
      `,
      [ name ]
    );

    return result.rows[0];
  }

  /**
   * 依 userId 查詢用戶資料
   * @param {number|string} id - userId
   * @returns {{ id, name, created_at }|null} 用戶資料，找不到時回傳 null
   */
  async getById(id) {
    const result = await this.pg.query(
      `
        SELECT id, name, created_at
        FROM users
        WHERE id = $1
      `,
      [ Number(id) ]
    );

    return result.rows[0] || null;
  }

  /**
   * 查詢指定用戶在 meta DB 的所有帳號 ID（依 id ASC 排序）
   * @param {number|string} userId
   * @returns {number[]} accountId 陣列
   */
  async listAccountIdsByUserId(userId) {
    const result = await this.pg.query(
      'SELECT id FROM accounts WHERE user_id = $1 ORDER BY id ASC',
      [ Number(userId) ]
    );
    return result.rows.map(row => Number(row.id));
  }
}

module.exports = UsersRepo;
