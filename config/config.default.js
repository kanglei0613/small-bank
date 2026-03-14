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

  // PostgreSQL sharding 設定
  // meta DB: 存 account_shards 這類 routing 資訊
  config.pgMeta = {
    host: '127.0.0.1',
    port: 5432,
    user: 'kanglei0613',
    password: '',
    database: 'small_bank_meta',

    // 每個 worker 的 connection pool size
    max: 5,

    // 連線閒置多久自動釋放
    idleTimeoutMillis: 30000,

    // 取得 connection 最多等多久
    connectionTimeoutMillis: 2000,

    // query 最長執行時間
    statement_timeout: 5000,
  };

  // shard DB
  config.pgShards = {
    0: {
      host: '127.0.0.1',
      port: 5432,
      user: 'kanglei0613',
      password: '',
      database: 'small_bank_s0',

      // 每個 worker 的 connection pool size
      max: 10,

      // 連線閒置多久自動釋放
      idleTimeoutMillis: 30000,

      // 取得 connection 最多等多久
      connectionTimeoutMillis: 2000,

      // query 最長執行時間
      statement_timeout: 5000,
    },

    1: {
      host: '127.0.0.1',
      port: 5432,
      user: 'kanglei0613',
      password: '',
      database: 'small_bank_s1',

      // 每個 worker 的 connection pool size
      max: 10,

      // 連線閒置多久自動釋放
      idleTimeoutMillis: 30000,

      // 取得 connection 最多等多久
      connectionTimeoutMillis: 2000,

      // query 最長執行時間
      statement_timeout: 5000,
    },

    2: {
      host: '127.0.0.1',
      port: 5432,
      user: 'kanglei0613',
      password: '',
      database: 'small_bank_s2',

      // 每個 worker 的 connection pool size
      max: 10,

      // 連線閒置多久自動釋放
      idleTimeoutMillis: 30000,

      // 取得 connection 最多等多久
      connectionTimeoutMillis: 2000,

      // query 最長執行時間
      statement_timeout: 5000,
    },

    3: {
      host: '127.0.0.1',
      port: 5432,
      user: 'kanglei0613',
      password: '',
      database: 'small_bank_s3',

      // 每個 worker 的 connection pool size
      max: 10,

      // 連線閒置多久自動釋放
      idleTimeoutMillis: 30000,

      // 取得 connection 最多等多久
      connectionTimeoutMillis: 2000,

      // query 最長執行時間
      statement_timeout: 5000,
    },
  };

  // shard 總數
  config.sharding = {
    shardCount: 4,
  };

  // Egg cluster
  exports.cluster = {
    listen: {
      port: 7001,
      hostname: '127.0.0.1',
    },
  };

  exports.cluster.workers = 12;

  exports.redis = {
    client: {
      host: '127.0.0.1',
      port: 6379,
      password: '',
      db: 0,
    },
  };

  // Redis transfer queue 設定
  config.transferQueue = {

    // 每個 fromId queue 的提早拒絕門檻
    // 當 queue 長度 >= 240 時，就開始拒絕新請求
    rejectThresholdPerFromId: 240,

    // 每個 fromId queue 的最大長度（硬上限）
    // 即使 admission control 沒先擋住，也不能超過這個值
    maxQueueLengthPerFromId: 300,

    // owner lock TTL（毫秒）
    ownerTtlMs: 10000,

    // owner heartbeat 刷新間隔（毫秒）
    ownerRefreshIntervalMs: 3000,

    // 每次 drain 從 queue 批次取出的 job 數量
    batchSize: 10,

  };

  const userConfig = {};

  return {
    ...config,
    ...userConfig,
  };
};
