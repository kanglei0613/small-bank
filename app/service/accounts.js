'use strict';

const AccountsRepo = require('../repository/accountsRepo');
const UsersRepo = require('../repository/usersRepo');
const cache = require('../lib/cache');

class AccountsService {
  constructor(ctx) {
    this.ctx = ctx;

    // 建立 accounts repository
    this.accountsRepo = new AccountsRepo(ctx);

    // 建立 users repository
    this.usersRepo = new UsersRepo(ctx);
  }

  // 建立帳戶
  async openAccount({ userId, initialBalance, balance } = {}) {
    const uid = Number(userId);

    // 檢查 userId
    if (!Number.isInteger(uid) || uid <= 0) {
      const err = new Error('userId must be a positive integer');
      err.status = 400;
      throw err;
    }

    const bal = (initialBalance !== undefined)
      ? Number(initialBalance)
      : Number(balance ?? 0);

    // 檢查 balance
    if (!Number.isFinite(bal) || bal < 0) {
      const err = new Error('balance must be a number >= 0');
      err.status = 400;
      throw err;
    }

    // 確認 user 存在
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

  // 依 id 查詢帳戶
  // 流程：
  // 1. 先驗證 account id
  // 2. 先查 Redis cache
  // 3. cache hit 就直接回傳
  // 4. cache miss 才查 PostgreSQL
  // 5. 查到後寫回 Redis，方便下次直接命中
  async getAccountById(id) {
    const aid = Number(id);

    // 檢查 id
    if (!Number.isInteger(aid) || aid <= 0) {
      const err = new Error('id must be a positive integer');
      err.status = 400;
      throw err;
    }

    const { app, logger } = this.ctx;
    const key = cache.accountKey(aid);

    // 先查 Redis
    try {
      const cached = await app.redis.get(key);

      if (cached) {
        logger.info('[Redis] account cache hit: %s', key);
        return cache.parseJSON(cached);
      }

      logger.info('[Redis] account cache miss: %s', key);
    } catch (err) {
      // Redis 失敗時不要中斷主流程，直接 fallback 到 DB
      logger.error('[Redis] get error, key=%s, err=%s', key, err.message);
    }

    // 查詢帳戶（從 PostgreSQL）
    const account = await this.accountsRepo.getById(aid);
    if (!account) {
      const err = new Error('account not found');
      err.status = 404;
      throw err;
    }

    // 把查到的帳戶資料寫回 Redis
    try {
      await app.redis.set(
        key,
        cache.stringify(account),
        'EX',
        cache.accountTTL()
      );

      logger.info('[Redis] account cache set: %s', key);
    } catch (err) {
      // Redis set 失敗也不要影響正常回傳
      logger.error('[Redis] set error, key=%s, err=%s', key, err.message);
    }

    return account;
  }

  // 刪除指定 account 的 cache
  // 之後 transfer 成功後會呼叫這個函數，避免讀到舊資料
  async invalidateAccountCache(id) {
    const aid = Number(id);

    // 檢查 id
    if (!Number.isInteger(aid) || aid <= 0) {
      const err = new Error('id must be a positive integer');
      err.status = 400;
      throw err;
    }

    const { app, logger } = this.ctx;
    const key = cache.accountKey(aid);

    // 刪除 Redis cache
    try {
      await app.redis.del(key);
      logger.info('[Redis] account cache deleted: %s', key);
    } catch (err) {
      logger.error('[Redis] del error, key=%s, err=%s', key, err.message);
    }
  }
}

module.exports = AccountsService;
