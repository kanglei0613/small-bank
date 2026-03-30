'use strict';

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
