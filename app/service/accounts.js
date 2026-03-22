'use strict';

const Service = require('egg').Service;
const AccountsRepo = require('../repository/accountsRepo');
const UsersRepo = require('../repository/usersRepo');
const cache = require('../lib/cache');
const { BadRequestError, NotFoundError } = require('../lib/errors');

class AccountsService extends Service {

  constructor(ctx) {
    super(ctx);
    this.accountsRepo = new AccountsRepo(ctx);
    this.usersRepo = new UsersRepo(ctx);
  }

  async openAccount({ userId, initialBalance, balance } = {}) {
    const uid = Number(userId);
    if (!Number.isInteger(uid) || uid <= 0) {
      throw new BadRequestError('userId must be a positive integer');
    }

    const bal = initialBalance !== undefined
      ? Number(initialBalance)
      : Number(balance != null ? balance : 0);

    if (!Number.isFinite(bal) || bal < 0) {
      throw new BadRequestError('initialBalance must be a non-negative number');
    }

    const user = await this.usersRepo.getById(uid);
    if (!user) {
      throw new NotFoundError('user not found');
    }

    return await this.accountsRepo.create({ userId: uid, initialBalance: bal });
  }

  async deposit({ accountId, amount }) {
    const aid = Number(accountId);
    const amt = Number(amount);

    if (!Number.isInteger(aid) || aid <= 0) {
      throw new BadRequestError('accountId must be a positive integer');
    }
    if (!Number.isInteger(amt) || amt <= 0) {
      throw new BadRequestError('amount must be a positive integer');
    }

    const result = await this.accountsRepo.deposit({ accountId: aid, amount: amt });
    await this.invalidateAccountCache(aid);
    return result;
  }

  async withdraw({ accountId, amount }) {
    const aid = Number(accountId);
    const amt = Number(amount);

    if (!Number.isInteger(aid) || aid <= 0) {
      throw new BadRequestError('accountId must be a positive integer');
    }
    if (!Number.isInteger(amt) || amt <= 0) {
      throw new BadRequestError('amount must be a positive integer');
    }

    const result = await this.accountsRepo.withdraw({ accountId: aid, amount: amt });
    await this.invalidateAccountCache(aid);
    return result;
  }

  async getAccountById(id) {
    const aid = Number(id);
    if (!Number.isInteger(aid) || aid <= 0) {
      throw new BadRequestError('accountId must be a positive integer');
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
      throw new NotFoundError('account not found');
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
    if (!Number.isInteger(aid) || aid <= 0) return;

    try {
      await this.ctx.app.redis.del(cache.accountKey(aid));
    } catch (err) {
      void err;
    }
  }
}

module.exports = AccountsService;
