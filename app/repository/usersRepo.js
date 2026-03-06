'use strict';

class UsersRepo {

  constructor(ctx) {
    this.ctx = ctx;

    // 取得PostgreSQL connection pool
    this.pg = ctx.app.pg;
  }

  // 建立user
  async create({ name }) {

    // 新增user並回傳資料
    const sql = `
      INSERT INTO users (name)
      VALUES ($1)
      RETURNING id, name, created_at
    `;

    // 執行SQL
    const result = await this.pg.query(sql, [ name ]);

    // 取得新增的row
    const row = result.rows[0];

    // 回傳user物件
    return {
      id: row.id,
      name: row.name,
      created_at: row.created_at,
    };
  }

  // 依id查詢user
  async getById(id) {

    // 查詢user
    const sql = `
      SELECT id, name, created_at
      FROM users
      WHERE id = $1
    `;

    // 執行SQL
    const result = await this.pg.query(sql, [ id ]);

    // 如果沒有資料
    if (result.rows.length === 0) {
      return null;
    }

    // 回傳user
    return result.rows[0];
  }
}

module.exports = UsersRepo;
