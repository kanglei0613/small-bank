'use strict';

const { Pool } = require('pg');

// app 啟動時，建立 meta DB 與各 shard 的 PostgreSQL connection pool
module.exports = app => {
  // meta DB
  const metaPg = new Pool(app.config.pgMeta);

  // shard DB map
  const shardPgMap = {};

  for (const shardId of Object.keys(app.config.pgShards)) {
    shardPgMap[shardId] = new Pool(app.config.pgShards[shardId]);
  }

  // 所有 request 共用同一組 pool
  app.metaPg = metaPg;
  app.shardPgMap = shardPgMap;

  // 在 server 啟動前測試 DB 連線
  app.beforeStart(async () => {
    // 測試 meta DB
    const metaClient = await app.metaPg.connect();
    try {
      await metaClient.query('SELECT 1');
      app.logger.info('[pg] meta DB connected');
    } finally {
      metaClient.release();
    }

    // 測試所有 shard DB
    for (const shardId of Object.keys(app.shardPgMap)) {
      const shardClient = await app.shardPgMap[shardId].connect();

      try {
        await shardClient.query('SELECT 1');
        app.logger.info('[pg] shard DB connected: shardId=%s', shardId);
      } finally {
        shardClient.release();
      }
    }
  });

  // 當 app 發生 error 時，log error
  app.on('error', err => {
    app.logger.error('[app error]', err);
  });
};
