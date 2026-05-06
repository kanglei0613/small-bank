'use strict';

/**
 * @file app/service/shard.js
 *
 * Shard 路由層（ShardService）
 *
 * 職責：
 * - getShardIdByAccountId：查詢 meta DB 的 account_shards 表，取得帳號所在 shard
 * - getShardPg：依 shardId 從 app.shardPgMap 取得對應的 PostgreSQL pool
 * - getShardPgByAccountId：組合以上兩步，直接從 accountId 取得 pg pool
 *
 * 注意：
 * - 實際轉帳邏輯已在 Repo 層以 calcShardId（accountId % 4）直接計算，不查 meta DB
 * - 此 Service 主要供外部需要明確 shardId 的場景使用（如偵錯、admin 工具）
 */

const Service = require('egg').Service;
const { BadRequestError, NotFoundError, InternalError } = require('../lib/errors');

class ShardService extends Service {

  // 依 accountId 取得 shardId
  async getShardIdByAccountId(accountId) {
    const aid = Number(accountId);

    if (!Number.isInteger(aid) || aid <= 0) {
      throw new BadRequestError('accountId must be a positive integer');
    }

    const sql = `
      SELECT shard_id
      FROM account_shards
      WHERE account_id = $1
      LIMIT 1
    `;

    const result = await this.app.metaPg.query(sql, [ aid ]);
    const row = result.rows[0];

    if (!row) {
      throw new NotFoundError('account not found');
    }

    return Number(row.shard_id);
  }

  // 依 shardId 取得對應的 PostgreSQL pool
  getShardPg(shardId) {
    const sid = Number(shardId);

    if (!Number.isInteger(sid) || sid < 0) {
      throw new BadRequestError('shardId must be a non-negative integer');
    }

    const shardPg = this.app.shardPgMap[sid];

    if (!shardPg) {
      throw new InternalError(`shard ${sid} not found`);
    }

    return shardPg;
  }

  // 依 accountId 直接取得對應 shard 的 PostgreSQL pool
  async getShardPgByAccountId(accountId) {
    const shardId = await this.getShardIdByAccountId(accountId);
    return this.getShardPg(shardId);
  }
}

module.exports = ShardService;
