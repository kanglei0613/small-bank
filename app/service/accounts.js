'use strict';

const AccountsRepo = require('../repository/accountsRepo');
const UsersRepo = require('../repository/usersRepo');

class AccountsService {
  constructor(ctx) {
    this.ctx = ctx;
    this.accountsRepo = new AccountsRepo(ctx.app);
    this.usersRepo = new UsersRepo(ctx);
  }

  async openAccount({ userId, initialBalance = 0 }) {
    const uid = Number(userId);
    if (!Number.isInteger(uid) || uid <= 0) {
      const err = new Error('userId must be a positive integer');
      err.status = 400;
      throw err;
    }

    const bal = Number(initialBalance);
    if (!Number.isFinite(bal) || bal < 0) {
      const err = new Error('initialBalance must be a number >= 0');
      err.status = 400;
      throw err;
    }

    const user = await this.usersRepo.getById(uid);
    if (!user) {
      const err = new Error('user not found');
      err.status = 404;
      throw err;
    }

    return await this.accountsRepo.create({ initialBalance: bal });
  }

  async getAccountById(id) {
    const aid = Number(id);
    if (!Number.isInteger(aid) || aid <= 0) {
      const err = new Error('id must be a positive integer');
      err.status = 400;
      throw err;
    }

    const account = await this.accountsRepo.getById(aid);
    if (!account) {
      const err = new Error('account not found');
      err.status = 404;
      throw err;
    }
    return account;
  }
}

module.exports = AccountsService;
