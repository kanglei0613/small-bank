'use strict';

const Service = require('egg').Service;
const UsersRepo = require('../repository/usersRepo');

class UsersService extends Service {

  constructor(ctx) {
    super(ctx);
    this.usersRepo = new UsersRepo(ctx);
  }

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

  async createUser({ name }) {
    if (!name || typeof name !== 'string' || !name.trim()) {
      const { BadRequestError } = require('../lib/errors');
      throw new BadRequestError('name is required');
    }

    return await this.usersRepo.create({ name: name.trim() });
  }
}

module.exports = UsersService;
