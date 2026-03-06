'use strict';

const AccountsRepo = require('../repository/accountsRepo');
const UsersRepo = require('../repository/usersRepo');

class AccountsService {
  constructor(ctx) {
    this.ctx = ctx;

    // 建立accounts repository
    this.accountsRepo = new AccountsRepo(ctx);

    // 建立users repository
    this.usersRepo = new UsersRepo(ctx);
  }

  // 建立帳戶
  async openAccount({ userId, initialBalance, balance } = {}) {
    const uid = Number(userId);

    // 檢查userId
    if (!Number.isInteger(uid) || uid <= 0) {
      const err = new Error('userId must be a positive integer');
      err.status = 400;
      throw err;
    }

    const bal = (initialBalance !== undefined)
      ? Number(initialBalance)
      : Number(balance ?? 0);

    // 檢查balance
    if (!Number.isFinite(bal) || bal < 0) {
      const err = new Error('balance must be a number >= 0');
      err.status = 400;
      throw err;
    }

    // 確認user存在
    const user = await this.usersRepo.getById(uid);
    if (!user) {
      const err = new Error('user not found');
      err.status = 404;
      throw err;
    }

    // 建立帳戶
    return await this.accountsRepo.create({
      userId: uid,
      initialBalance: bal,
    });
  }

  // 依id查詢帳戶
  async getAccountById(id) {
    const aid = Number(id);

    // 檢查id
    if (!Number.isInteger(aid) || aid <= 0) {
      const err = new Error('id must be a positive integer');
      err.status = 400;
      throw err;
    }

    // 查詢帳戶
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
