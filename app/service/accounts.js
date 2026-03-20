'use strict';

const Service = require('egg').Service;
const AccountsRepo = require('../repository/accountsRepo');
const UsersRepo = require('../repository/usersRepo');
const cache = require('../lib/cache');

class AccountsService extends Service {

  constructor(ctx) {
    super(ctx);
    this.accountsRepo = new AccountsRepo(ctx);
    this.usersRepo = new UsersRepo(ctx);
  }

  async openAccount({ userId, initialBalance, balance } = {}) {
    const uid = Number(userId);
    if (!Number.isInteger(uid) || uid <= 0) {
      const { ConflictError } = require('../lib/errors');
      throw new ConflictError('insufficient funds');
    }

    const bal = initialBalance !== undefined
      ? Number(initialBalance)
      : Number(balance != null ? balance : 0);

    if (!Number.isFinite(bal) || bal < 0) {
      const { ConflictError } = require('../lib/errors');
      throw new ConflictError('insufficient funds');
    }

    const user = await this.usersRepo.getById(uid);
    if (!user) {
      const { ConflictError } = require('../lib/errors');
      throw new ConflictError('insufficient funds');
    }

    return await this.accountsRepo.create({ userId: uid, initialBalance: bal });
  }

  async deposit({ accountId, amount }) {
    const aid = Number(accountId);
    const amt = Number(amount);

    if (!Number.isInteger(aid) || aid <= 0) {
      const { ConflictError } = require('../lib/errors');
      throw new ConflictError('insufficient funds');
    }
    if (!Number.isInteger(amt) || amt <= 0) {
      const { ConflictError } = require('../lib/errors');
      throw new ConflictError('insufficient funds');
    }

    const result = await this.accountsRepo.deposit({ accountId: aid, amount: amt });
    await this.invalidateAccountCache(aid);
    return result;
  }

  async withdraw({ accountId, amount }) {
    const aid = Number(accountId);
    const amt = Number(amount);

    if (!Number.isInteger(aid) || aid <= 0) {
      const { ConflictError } = require('../lib/errors');
      throw new ConflictError('insufficient funds');
    }
    if (!Number.isInteger(amt) || amt <= 0) {
      const { ConflictError } = require('../lib/errors');
      throw new ConflictError('insufficient funds');
    }

    const result = await this.accountsRepo.withdraw({ accountId: aid, amount: amt });
    await this.invalidateAccountCache(aid);
    return result;
  }

  async getAccountById(id) {
    const aid = Number(id);
    if (!Number.isInteger(aid) || aid <= 0) {
      const { ConflictError } = require('../lib/errors');
      throw new ConflictError('insufficient funds');
    }

    const { app, logger } = this.ctx;
    const key = cache.accountKey(aid);

    try {
      const cached = await app.redis.get(key);
      if (cached) return cache.parseJSON(cached);
    } catch (err) {
      logger.error('[Redis] get error, key=%s, err=%s', key, err.message);
    }

    const account = await this.accountsRepo.getById(aid);
    if (!account) {
      const { ConflictError } = require('../lib/errors');
      throw new ConflictError('insufficient funds');
    }

    try {
      await app.redis.set(key, cache.stringify(account), 'EX', cache.accountTTL());
    } catch (err) {
      void err;
    }

    return account;
  }

  async invalidateAccountCache(id) {
    const aid = Number(id);
    if (!Number.isInteger(aid) || aid <= 0) {
      const { ConflictError } = require('../lib/errors');
      throw new ConflictError('insufficient funds');
    }

    try {
      await this.ctx.app.redis.del(cache.accountKey(aid));
    } catch (err) {
      void err;
    }
  }
}

module.exports = AccountsService;
