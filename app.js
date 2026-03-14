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

  // 記錄目前 app role
  // - APP_ROLE=api   → 只提供 HTTP API，不啟動 queue worker
  // - APP_ROLE=queue → 啟動 queue worker，背景處理 transfer job
  app.role = process.env.APP_ROLE || 'api';

  // 在 server 啟動前測試 DB 連線
  app.beforeStart(async () => {
    app.logger.info('[app] current role = %s', app.role);

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

    // queue role：啟動背景 queue worker
    //
    // 注意：
    // - API role 不會啟動 queue worker
    // - queue role 會在 app 啟動後進入背景 loop，持續掃描 queue 並 drain
    if (app.role === 'queue') {
      app.logger.info('[queue worker] queue role detected, worker will start');

      // 使用 setImmediate，避免阻塞 beforeStart 完成
      setImmediate(async () => {
        const ctx = app.createAnonymousContext();

        try {
          await ctx.service.transfers.startQueueWorker();
        } catch (err) {
          app.logger.error(
            '[queue worker] start failed: %s',
            err && (err.stack || err.message)
          );
        }
      });
    } else {
      app.logger.info('[queue worker] api role detected, worker will not start');
    }
  });

  // 當 app 發生 error 時，log error
  app.on('error', err => {
    app.logger.error('[app error]', err);
  });
};
