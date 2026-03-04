'use strict';

const AccountsRepo = require('../repository/accountsRepo');
const UsersRepo = require('../repository/usersRepo');

class AccountsService {
  constructor(ctx) {
    this.ctx = ctx;
    this.accountsRepo = new AccountsRepo(ctx.app);
    this.usersRepo = new UsersRepo(ctx);
  }

  async openAccount({ userId, initialBalance, balance } = {}) {
    const uid = Number(userId);
    if (!Number.isInteger(uid) || uid <= 0) {
      const err = new Error('userId must be a positive integer');
      err.status = 400;
      throw err;
    }

    const bal = (initialBalance !== undefined)
      ? Number(initialBalance)
      : Number(balance ?? 0);

    if (!Number.isFinite(bal) || bal < 0) {
      const err = new Error('balance must be a number >= 0');
      err.status = 400;
      throw err;
    }

    // Sharding mode:
    // users 在 small_bank DB
    // accounts 在 shard DB
    // 所以先跳過 user existence check
    // const user = await this.usersRepo.getById(uid);
    // if (!user) {
    //   const err = new Error('user not found');
    //   err.status = 404;
    //   throw err;
    // }

    return await this.accountsRepo.create({
      userId: uid,
      initialBalance: bal,
    });
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
