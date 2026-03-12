'use strict';

class UsersRepo {

  constructor(ctx) {
    this.ctx = ctx;

    // users 目前放在 meta DB
    this.pg = ctx.app.metaPg;
  }

  // 建立 user
  async create({ name }) {

    // 檢查 name
    if (!name || typeof name !== 'string') {
      const err = new Error('name is required');
      err.status = 400;
      throw err;
    }

    // 新增 user 並回傳資料
    const sql = `
      INSERT INTO users (name)
      VALUES ($1)
      RETURNING id, name, created_at
    `;

    // 執行 SQL
    const result = await this.pg.query(sql, [ name ]);

    // 取得新增的 row
    const row = result.rows[0];

    // 回傳 user 物件
    return {
      id: row.id,
      name: row.name,
      created_at: row.created_at,
    };
  }

  // 依 id 查詢 user
  async getById(id) {
    const userId = Number(id);

    // 檢查 id
    if (!Number.isInteger(userId) || userId <= 0) {
      const err = new Error('id must be a positive integer');
      err.status = 400;
      throw err;
    }

    // 查詢 user
    const sql = `
      SELECT id, name, created_at
      FROM users
      WHERE id = $1
    `;

    // 執行 SQL
    const result = await this.pg.query(sql, [ userId ]);

    // 如果沒有資料
    if (result.rows.length === 0) {
      return null;
    }

    // 回傳 user
    return result.rows[0];
  }
}

module.exports = UsersRepo;
