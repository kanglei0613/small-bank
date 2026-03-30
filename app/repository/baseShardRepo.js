'use strict';

class BaseShardRepo {

  constructor(ctx) {
    this.ctx = ctx;
    this.metaPg = ctx.app.metaPg;
  }

  calcShardId(accountId) {
    const shardCount = Number(this.ctx.app.config.sharding.shardCount);
    return Number(accountId) % shardCount;
  }

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
