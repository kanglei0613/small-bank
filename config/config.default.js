/* eslint valid-jsdoc: "off" */

/**
 * @param {Egg.EggAppInfo} appInfo app info
 */
module.exports = appInfo => {
  const config = exports = {};

  config.keys = appInfo.name + '_1772514479316_723';

  config.middleware = [];

  config.security = {
    csrf: { enable: false },
  };

  /**
   * PostgreSQL connection pool
   * 單一資料庫 (不做 sharding)
   */
  config.pg = {
    host: 'localhost',
    port: 5432,
    user: 'kanglei0613',
    password: '',
    database: 'small_bank',

    // 每個 worker 的 connection pool size
    max: 10,

    // 連線閒置多久自動釋放
    idleTimeoutMillis: 30000,

    // 取得 connection 最多等多久
    connectionTimeoutMillis: 2000,

    // query 最長執行時間 (避免 transaction 卡死)
    statement_timeout: 5000,
  };

  /**
   * Egg cluster
   * 開 8 個 workers 提高併發能力
   */
  config.cluster = {
    listen: {
      port: 7001,
      hostname: '127.0.0.1',
    },
    workers: 8,
  };

  exports.redis = {
    client: {
      host: '127.0.0.1',
      port: 6379,
      password: '',
      db: 0,
    },
  };

  const userConfig = {};

  return {
    ...config,
    ...userConfig,
  };
};
