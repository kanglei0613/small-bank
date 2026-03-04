'use strict';

const { getNamedPool } = require('./pgMulti');

class ShardRouterRepo {
  constructor(app) {
    this.app = app;
    this.metaPool = getNamedPool('meta', app.config.pgMeta);
    this.shardPools = app.config.pgShards.map((cfg, i) => getNamedPool(`shard_${i}`, cfg));
  }

  shardCount() {
    return this.shardPools.length;
  }

  getShardPool(shardId) {
    const p = this.shardPools[shardId];
    if (!p) {
      const err = new Error(`invalid shardId: ${shardId}`);
      err.status = 500;
      throw err;
    }
    return p;
  }

  async getShardIdByAccountId(accountId) {
    const res = await this.metaPool.query(
      'SELECT shard_id FROM account_shards WHERE account_id = $1',
      [ accountId ]
    );
    return res.rows[0]?.shard_id ?? null;
  }

  async allocateAccountIdAndShard() {
    const res = await this.metaPool.query('SELECT nextval(\'account_id_seq\') AS id');
    const accountId = Number(res.rows[0].id);
    const shardId = accountId % this.shardCount();
    return { accountId, shardId };
  }

  async registerAccountShard(accountId, shardId) {
    await this.metaPool.query(
      'INSERT INTO account_shards(account_id, shard_id) VALUES ($1, $2)',
      [ accountId, shardId ]
    );
  }
}

module.exports = ShardRouterRepo;
