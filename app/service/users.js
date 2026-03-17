'use strict';

// 引入 Users repository（負責 DB 操作）
const UsersRepo = require('../repository/usersRepo');

class UsersService {

  // 初始化 service
  constructor(ctx) {
    this.ctx = ctx;

    // 建立 repository instance
    this.usersRepo = new UsersRepo(ctx);
  }

  // 依 id 查詢 user
  async getUserById(id) {

    // 將 id 轉為數字
    const userId = Number(id);

    // 檢查 id 是否為正整數
    if (!Number.isInteger(userId) || userId <= 0) {
      const err = new Error('id must be a positive integer');
      err.status = 400;
      throw err;
    }

    // 從 repository 查詢 user
    const user = await this.usersRepo.getById(userId);

    // user 不存在
    if (!user) {
      const err = new Error('user not found');
      err.status = 404;
      throw err;
    }

    // 查詢這個 user 底下有哪些 account
    const accounts = [];

    for (const shardId of Object.keys(this.ctx.app.shardPgMap)) {
      const shardPg = this.ctx.app.shardPgMap[shardId];

      const result = await shardPg.query(
        `
          SELECT id
          FROM accounts
          WHERE user_id = $1
          ORDER BY id ASC
        `,
        [ userId ]
      );

      for (const row of result.rows) {
        accounts.push(Number(row.id));
      }
    }

    // 回傳 user + accounts
    return {
      ...user,
      accounts,
    };
  }

  // 建立 user
  async createUser({ name }) {

    // 檢查 name 是否有效
    if (!name || typeof name !== 'string' || !name.trim()) {
      const err = new Error('name is required');
      err.status = 400;
      throw err;
    }

    // 呼叫 repository 建立 user
    return await this.usersRepo.create({
      name: name.trim(),
    });
  }
}

module.exports = UsersService;
