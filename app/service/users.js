'use strict';

// 引入Users repository（負責 DB 操作）
const UsersRepo = require('../repository/usersRepo');

class UsersService {

  // 初始化service
  constructor(ctx) {
    this.ctx = ctx;

    // 建立repository instance
    this.usersRepo = new UsersRepo(ctx);
  }

  // 依id查詢user
  async getUserById(id) {

    // 將id轉為數字
    const userId = Number(id);

    // 檢查id是否為正整數
    if (!Number.isInteger(userId) || userId <= 0) {
      const err = new Error('id must be a positive integer');
      err.status = 400;
      throw err;
    }

    // 從repository查詢user
    const user = await this.usersRepo.getById(userId);

    // user不存在
    if (!user) {
      const err = new Error('user not found');
      err.status = 404;
      throw err;
    }

    // 回傳user
    return user;
  }

  // 建立user
  async createUser({ name }) {

    // 檢查name是否有效
    if (!name || typeof name !== 'string' || !name.trim()) {
      const err = new Error('name is required');
      err.status = 400;
      throw err;
    }

    // 呼叫repository建立 user
    return await this.usersRepo.create({
      name: name.trim(),
    });
  }
}

module.exports = UsersService;
