'use strict';

/**
 * @file app/service/users.js
 *
 * 用戶業務邏輯層（UsersService）
 *
 * 職責：
 * - createUser：驗證 name 後寫入 meta DB，回傳新建用戶資料
 * - getUserById：查詢用戶基本資料，同時列出該用戶所有 accountId
 */

const Service = require('egg').Service;
const UsersRepo = require('../repository/usersRepo');

class UsersService extends Service {

  constructor(ctx) {
    super(ctx);
    this.usersRepo = new UsersRepo(ctx);
  }

  /**
   * 查詢用戶資料，並附帶該用戶所有的 accountId 列表
   * @param {number|string} id - userId
   * @returns {{ id, name, created_at, accounts: number[] }}
   */
  async getUserById(id) {
    const userId = Number(id);
    if (!Number.isInteger(userId) || userId <= 0) {
      const { BadRequestError } = require('../lib/errors');
      throw new BadRequestError('userId must be a positive integer');
    }

    const user = await this.usersRepo.getById(userId);
    if (!user) {
      const { NotFoundError } = require('../lib/errors');
      throw new NotFoundError('user not found');
    }

    const accountIds = await this.usersRepo.listAccountIdsByUserId(userId);

    return { ...user, accounts: accountIds };
  }

  /**
   * 建立新用戶，name 不得為空字串或純空白
   * @param {{ name: string }} params
   * @returns {{ id, name, created_at }}
   */
  async createUser({ name }) {
    if (!name || typeof name !== 'string' || !name.trim()) {
      const { BadRequestError } = require('../lib/errors');
      throw new BadRequestError('name is required');
    }

    return await this.usersRepo.create({ name: name.trim() });
  }
}

module.exports = UsersService;
