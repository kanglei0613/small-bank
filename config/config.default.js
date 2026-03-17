/* eslint valid-jsdoc: "off" */

/**
 * config.default.js
 *
 * 作用：
 * - 設定 Egg 基本參數
 * - 設定 PostgreSQL meta DB / shard DB
 * - 設定 Redis
 * - 設定 transfer queue
 * - 設定 API role（general / transfer / all）
 *
 * 使用方式：
 *
 * 一般 API server：
 * APP_API_ROLE=general egg-bin dev --port=7001
 *
 * transfer API server：
 * APP_API_ROLE=transfer egg-bin dev --port=7010
 *
 * 若未指定 APP_API_ROLE，預設為 all
 * 表示所有路由都註冊，適合單機開發或舊模式
 */

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

  config.cors = {
    origin: '*',
    allowMethods: 'GET,HEAD,PUT,POST,DELETE,PATCH,OPTIONS',
  };

  // =========================
  // API Role 設定
  // =========================
  //
  // 用來決定這個 API process 要掛哪些 router
  //
  // all:
  //   - 預設值
  //   - 所有 API 都開
  //
  // general:
  //   - 一般 API
  //   - users / accounts / transfer jobs / transfer history / queue / bench
  //
  // transfer:
  //   - 只開 POST /transfers
  //
  config.apiRole = process.env.APP_API_ROLE || 'all';

  // =========================
  // PostgreSQL sharding 設定
  // =========================
  //
  // meta DB:
  // - 存 account_shards 等 routing 資訊
  //
  config.pgMeta = {
    host: '127.0.0.1',
    port: 5432,
    user: 'kanglei0613',
    password: '',
    database: 'small_bank_meta',

    // 每個 worker 的 connection pool size
    max: 2,

    // 連線閒置多久自動釋放
    idleTimeoutMillis: 30000,

    // 取得 connection 最多等多久
    connectionTimeoutMillis: 2000,

    // query 最長執行時間
    statement_timeout: 5000,
  };

  // =========================
  // shard DB 設定
  // =========================
  //
  // 每個 shard 都是一個獨立 PostgreSQL database
  //
  config.pgShards = {
    0: {
      host: '127.0.0.1',
      port: 5432,
      user: 'kanglei0613',
      password: '',
      database: 'small_bank_s0',

      // 每個 worker 的 connection pool size
      max: 5,

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
      max: 5,

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
      max: 5,

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
      max: 5,

      // 連線閒置多久自動釋放
      idleTimeoutMillis: 30000,

      // 取得 connection 最多等多久
      connectionTimeoutMillis: 2000,

      // query 最長執行時間
      statement_timeout: 5000,
    },
  };

  // =========================
  // shard 總數
  // =========================
  config.sharding = {
    shardCount: 4,
  };

  // =========================
  // Egg cluster 設定
  // =========================
  //
  // 可透過環境變數覆蓋：
  // - APP_PORT
  // - APP_WORKERS
  //
  // =========================
  // Egg cluster 設定
  // =========================
  //
  // 可透過環境變數覆蓋：
  // - APP_PORT
  // - APP_WORKERS
  //
  exports.cluster = {
    listen: {
      port: Number(process.env.APP_PORT || 7001),
      hostname: '127.0.0.1',
    },
    workers: Number(process.env.APP_WORKERS || 1),
  };
  // =========================
  // Redis 設定
  // =========================
  exports.redis = {
    client: {
      host: '127.0.0.1',
      port: 6379,
      password: '',
      db: 0,
    },
  };

  // =========================
  // Redis transfer queue 設定
  // =========================
  //
  // 目前 queue 架構：
  // - per-fromId queue
  // - ready queue
  // - owner lock
  //
  config.transferQueue = {

    // 每個 fromId queue 的提早拒絕門檻
    // 當 queue 長度 >= 320 時，就開始拒絕新請求
    rejectThresholdPerFromId: 320,

    // 每個 fromId queue 的最大長度（硬上限）
    // 即使 admission control 沒先擋住，也不能超過這個值
    maxQueueLengthPerFromId: 400,

    // owner lock TTL（毫秒）
    ownerTtlMs: 10000,

    // owner heartbeat 刷新間隔（毫秒）
    ownerRefreshIntervalMs: 3000,

    // 每次 drain 從 queue 批次取出的 job 數量
    batchSize: 20,

    // ready queue block pop timeout（秒）
    // queue worker 會 BRPOP ready queue
    readyQueueBlockTimeoutSec: 1,

    // worker loop error 時的 sleep 時間（毫秒）
    workerErrorSleepMs: 1000,
  };

  const userConfig = {};

  return {
    ...config,
    ...userConfig,
  };
};
