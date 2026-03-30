'use strict';

class UsersRepo {

  constructor(ctx) {
    this.pg = ctx.app.metaPg;
  }

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

  async listAccountIdsByUserId(userId) {
    const result = await this.pg.query(
      'SELECT id FROM accounts WHERE user_id = $1 ORDER BY id ASC',
      [ Number(userId) ]
    );
    return result.rows.map(row => Number(row.id));
  }
}

module.exports = UsersRepo;
