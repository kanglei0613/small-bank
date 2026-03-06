'use strict';

const { Pool } = require('pg');

// when app starts, create a PostgreSQL connection pool and attach it to app.pg
module.exports = app => {
  // 單一資料庫 (不做 sharding)
  const pool = new Pool(app.config.pg);

  // 所有request共用同一個 pool
  app.pg = pool;

  // 在server啟動前測試DB, 預載cache, migration, 初始化
  app.beforeStart(async () => {
    const client = await app.pg.connect();
    try {
      await client.query('SELECT 1');
      app.logger.info('[pg] PostgreSQL connected');
    } finally {
      client.release();
    }
  });

  // 當app發生error時, log error
  app.on('error', err => {
    app.logger.error('[app error]', err);
  });
};
