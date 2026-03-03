'use strict';

const UsersRepo = require('../repository/usersRepo');

class UsersService {
  constructor(ctx) {
    this.ctx = ctx;
    this.usersRepo = new UsersRepo(ctx);
  }
  async getUserById(id) {
    const userId = Number(id);
    if (!Number.isInteger(userId) || userId <= 0) {
      const err = new Error('id must be a positive integer');
      err.status = 400;
      throw err;
    }

    const user = await this.usersRepo.getById(userId);
    if (!user) {
      const err = new Error('user not found');
      err.status = 404;
      throw err;
    }
    return user;
  }
  async createUser({ name }) {
    if (!name || typeof name !== 'string' || !name.trim()) {
      const err = new Error('name is required');
      err.status = 400;
      throw err;
    }
    return await this.usersRepo.create({ name: name.trim() });
  }
}

module.exports = UsersService;
