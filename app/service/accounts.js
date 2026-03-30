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
    const uid = Number(userId); // 確認 userId 為數字型態
    if (!Number.isInteger(uid) || uid <= 0) {
      throw new BadRequestError('userId must be a positive integer');
    }

    // 處理初始餘額，支援不同變數名稱
    const bal = initialBalance !== undefined
      ? Number(initialBalance)
      : Number(balance != null ? balance : 0);

    // 金額校驗，不能是負數或 NaN
    if (!Number.isFinite(bal) || bal < 0) {
      throw new BadRequestError('initialBalance must be a non-negative number');
    }

    // 先去 usersRepo 確認 user 是否存在
    const user = await this.usersRepo.getById(uid);
    if (!user) {
      throw new NotFoundError('user not found');
    }

    // 寫入資料庫，將任務交給 Repo 層進行 INSERT
    return await this.accountsRepo.create({ userId: uid, initialBalance: bal });
  }

  // 存款
  async deposit({ accountId, amount }) {
    const aid = Number(accountId);
    const amt = Number(amount);

    if (!Number.isInteger(aid) || aid <= 0) {
      throw new BadRequestError('accountId must be a positive integer');
    }
    if (!Number.isInteger(amt) || amt <= 0) {
      throw new BadRequestError('amount must be a positive integer');
    }

    // 寫入 DB ， 增加餘額
    const result = await this.accountsRepo.deposit({ accountId: aid, amount: amt });
    await this.invalidateAccountCache(aid);
    return result;
  }

  // 提款
  async withdraw({ accountId, amount }) {
    const aid = Number(accountId);
    const amt = Number(amount);

    if (!Number.isInteger(aid) || aid <= 0) {
      throw new BadRequestError('accountId must be a positive integer');
    }
    if (!Number.isInteger(amt) || amt <= 0) {
      throw new BadRequestError('amount must be a positive integer');
    }

    // 寫入 DB ，減少餘額
    const result = await this.accountsRepo.withdraw({ accountId: aid, amount: amt });
    await this.invalidateAccountCache(aid);
    return result;
  }

  // 查帳戶餘額
  async getAccountById(id) {
    const aid = Number(id);
    if (!Number.isInteger(aid) || aid <= 0) {
      throw new BadRequestError('accountId must be a positive integer');
    }

    const { app, logger } = this.ctx;
    const key = cache.accountKey(aid); // 取得 Redis key 的名稱

    try {
      const cached = await app.redis.get(key); // 先從 Redis 嘗試拿資料
      if (cached) return cache.parseJSON(cached); // 如果 Redis 有，直接回傳
    } catch (err) {
      logger.error('[Redis] get error, key=%s, err=%s', key, err.message); // 如果 Redis 出問題了，只打 log ，不要讓整個 API 癱瘓
    }

    // 如果 Redis 中沒有資料，再去找資料庫
    const account = await this.accountsRepo.getById(aid);
    // 判斷是否有 account 存在
    if (!account) {
      throw new NotFoundError('account not found');
    }

    try {
      await app.redis.set(key, cache.stringify(account), 'EX', cache.accountTTL()); // 回填 Redis，且設置資料在 Redis 裡的過期時間
    } catch (err) {
      void err; // 就算寫入 Redis 失敗，還是會去資料庫查詢，所以靜默處理，查詢仍從資料庫拿到正確資料
    }

    return account;
  }

  // 刪除 Cache 裡的舊資料
  async invalidateAccountCache(id) {
    const aid = Number(id);
    if (!Number.isInteger(aid) || aid <= 0) return;

    try {
      await this.ctx.app.redis.del(cache.accountKey(aid)); // 刪除 Redis 裡的資料，如果不刪，下一次從 Cache 裡找到的可能是舊資料
    } catch (err) {
      void err; // 靜默處理，頂多讓使用者暫時查詢到舊餘額，但實際交易不受影響，是一種容錯降級的手段，雖然可能會有髒讀的情況，但用一點延遲換取系統穩定性
    }
  }
}

module.exports = AccountsService;
