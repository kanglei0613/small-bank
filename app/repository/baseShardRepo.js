'use strict';

/**
 * @file app/repository/baseShardRepo.js
 *
 * Shard Repo 基底類別（BaseShardRepo）
 *
 * 職責：
 * - calcShardId：依 accountId % shardCount 計算所屬 shard（不查 meta DB，純計算）
 * - getShardPg：依 shardId 從 app.shardPgMap 取得對應的 PostgreSQL pool
 *
 * 所有需要存取 shard DB 的 Repo（AccountsRepo、TransfersRepo）均繼承此類別。
 */

class BaseShardRepo {

  constructor(ctx) {
    this.ctx = ctx;
    this.metaPg = ctx.app.metaPg;
  }

  /**
   * 依 accountId % shardCount 計算所屬 shardId（純計算，不查 DB）
   * @param {number|string} accountId
   * @returns {number} shardId（0 ~ shardCount-1）
   */
  calcShardId(accountId) {
    const shardCount = Number(this.ctx.app.config.sharding.shardCount);
    return Number(accountId) % shardCount;
  }

  /**
   * 依 shardId 取得對應的 PostgreSQL pool
   * @param {number} shardId
   * @returns {import('pg').Pool} 對應 shard 的 pg pool
   * @throws {ConflictError} 若 shardId 不存在於 shardPgMap
   */
  getShardPg(shardId) {
    const shardPg = this.ctx.app.shardPgMap[shardId];

    if (!shardPg) {
      const { ConflictError } = require('../lib/errors');
      throw new ConflictError('shard not found');
    }

    return shardPg;
  }
}

module.exports = BaseShardRepo;
