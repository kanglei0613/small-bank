'use strict';

const { Pool } = require('pg');
const Redis = require('ioredis');

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

  // SSE 專用的 Redis subscriber connection
  //
  // 注意：
  // - Redis connection 進入 subscribe 模式後，只能收訊息，不能做其他操作
  // - 所以需要獨立的 connection，不能共用 app.redis
  // - queue role 不需要 SSE，只在 api role 建立
  // 所有 role 都建立獨立 ioredis 直連，繞過 egg cluster-client IPC 延遲
  // 用於 enqueueTransfer、createJob、pushJob 等需要低延遲的操作
  {
    const redisConfig = app.config.redis && app.config.redis.client
      ? app.config.redis.client
      : { host: '127.0.0.1', port: 6379, db: 0 };

    app.redisDb = new Redis({
      host: redisConfig.host || '127.0.0.1',
      port: redisConfig.port || 6379,
      password: redisConfig.password || undefined,
      db: redisConfig.db || 0,
    });

    app.redisDb.on('error', err => {
      app.logger.error('[redisDb] connection error: %s', err && err.message);
    });
  }

  if (app.role !== 'queue') {
    const redisConfig = app.config.redis && app.config.redis.client
      ? app.config.redis.client
      : { host: '127.0.0.1', port: 6379, db: 0 };

    app.redisSub = new Redis({
      host: redisConfig.host || '127.0.0.1',
      port: redisConfig.port || 6379,
      password: redisConfig.password || undefined,
      db: redisConfig.db || 0,
    });

    app.redisSub.on('error', err => {
      app.logger.error('[redisSub] connection error: %s', err && err.message);
    });
  }

  // 在 server 啟動前測試 DB 連線
  app.beforeStart(async () => {
    // app.logger.info('[app] current role = %s', app.role);

    // 測試 meta DB
    const metaClient = await app.metaPg.connect();
    try {
      await metaClient.query('SELECT 1');
      // app.logger.info('[pg] meta DB connected');
    } finally {
      metaClient.release();
    }

    // 測試所有 shard DB
    for (const shardId of Object.keys(app.shardPgMap)) {
      const shardClient = await app.shardPgMap[shardId].connect();

      try {
        await shardClient.query('SELECT 1');
        // app.logger.info('[pg] shard DB connected: shardId=%s', shardId);
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
      const CONCURRENCY = parseInt(process.env.QUEUE_CONCURRENCY || '4');

      setImmediate(async () => {
        const loops = Array.from({ length: CONCURRENCY }, () => {
          const ctx = app.createAnonymousContext();
          return ctx.service.transfers.startQueueWorker().catch(err => {
            app.logger.error(
              '[queue worker] loop failed: %s',
              err && (err.stack || err.message)
            );
          });
        });

        await Promise.all(loops);
      });
    } else {
      // app.logger.info('[queue worker] api role detected, worker will not start');
    }

  });

  // 當 app 發生 error 時，log error
  app.on('error', err => {
    app.logger.error('[app error]', err);
  });
};
