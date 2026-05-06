'use strict';

/**
 * @file app/repository/pg.js
 *
 * PostgreSQL Connection Pool 工廠（單例）
 *
 * 職責：
 * - getPool：依傳入 config 建立並快取 pg Pool（Singleton 模式）
 *
 * 注意：
 * - 此模組為早期版本遺留，正式環境已改用 app.js 中直接以 new Pool() 建立 metaPg / shardPgMap
 * - 目前僅在部分獨立腳本中使用
 */

const { Pool } = require('pg');

let pool;

/**
 * 建立或取得已快取的 PostgreSQL connection pool
 * @param {{ host?, port?, database?, user?, password?, max? }} config
 * @returns {import('pg').Pool}
 */
function getPool(config) {
  config = config || {};

  if (!pool) {
    pool = new Pool({
      host: config.host || 'localhost',
      port: config.port || 5432,
      database: config.database || 'small_bank',
      user: config.user,
      password: config.password,
      max: config.max || 50,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  }

  return pool;
}

module.exports = { getPool };
