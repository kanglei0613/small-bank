'use strict';

const Service = require('egg').Service;

class ShardService extends Service {

  // 依 accountId 取得 shardId
  async getShardIdByAccountId(accountId) {
    const aid = Number(accountId);

    // 檢查 accountId
    if (!Number.isInteger(aid) || aid <= 0) {
      const err = new Error('accountId must be a positive integer');
      err.status = 400;
      throw err;
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
      const err = new Error('account shard not found');
      err.status = 404;
      throw err;
    }

    return Number(row.shard_id);
  }

  // 依 shardId 取得對應的 PostgreSQL pool
  getShardPg(shardId) {
    const sid = Number(shardId);

    // 檢查 shardId
    if (!Number.isInteger(sid) || sid < 0) {
      const err = new Error('shardId must be a non-negative integer');
      err.status = 400;
      throw err;
    }

    const shardPg = this.app.shardPgMap[sid];

    if (!shardPg) {
      const err = new Error(`shard DB not found: ${sid}`);
      err.status = 500;
      throw err;
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
