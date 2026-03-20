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
 *
 * 可調整的環境變數：
 *
 * DB connection pool：
 *   PG_META_POOL_MAX                    meta DB pool max (預設: 2)
 *   PG_SHARD_POOL_MAX                   每個 shard DB pool max (預設: 5)
 *
 * Transfer queue：
 *   TRANSFER_QUEUE_REJECT_THRESHOLD     per-fromId 拒絕閾值 (預設: 240)
 *   TRANSFER_QUEUE_MAX_LENGTH           per-fromId 最大長度 (預設: 300)
 *   TRANSFER_QUEUE_OWNER_TTL_MS         owner lock TTL ms (預設: 10000)
 *   TRANSFER_QUEUE_OWNER_REFRESH_MS     owner lock refresh interval ms (預設: 3000)
 *   TRANSFER_QUEUE_BATCH_SIZE           drain batch size (預設: 50)
 *   TRANSFER_QUEUE_BLOCK_TIMEOUT_SEC    ready queue block timeout sec (預設: 1)
 */

/**
 * @param {Egg.EggAppInfo} appInfo app info
 */
module.exports = appInfo => {
  const config = exports = {};

  config.keys = appInfo.name + '_1772514479316_723';

  config.middleware = [ 'errorHandler' ];

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

  const pgMetaPoolMax = parseInt(process.env.PG_META_POOL_MAX || '2');
  const pgShardPoolMax = parseInt(process.env.PG_SHARD_POOL_MAX || '5');

  // meta DB:
  // - 存 account_shards 等 routing 資訊
  //
  config.pgMeta = {
    host: '127.0.0.1',
    port: 5432,
    user: 'kanglei0613',
    password: '',
    database: 'small_bank_meta',
    max: pgMetaPoolMax,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  };

  // =========================
  // shard DB 設定
  // =========================
  //
  // 每個 shard 都是一個獨立 PostgreSQL database
  //
  const shardBase = {
    host: '127.0.0.1',
    port: 5432,
    user: 'kanglei0613',
    password: '',
    max: pgShardPoolMax,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
  };

  config.pgShards = {
    0: Object.assign({}, shardBase, { database: 'small_bank_s0' }),
    1: Object.assign({}, shardBase, { database: 'small_bank_s1' }),
    2: Object.assign({}, shardBase, { database: 'small_bank_s2' }),
    3: Object.assign({}, shardBase, { database: 'small_bank_s3' }),
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
      keepAlive: 10000,
      connectTimeout: 5000,
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
    rejectThresholdPerFromId: parseInt(process.env.TRANSFER_QUEUE_REJECT_THRESHOLD || '240'),
    maxQueueLengthPerFromId: parseInt(process.env.TRANSFER_QUEUE_MAX_LENGTH || '300'),
    ownerTtlMs: parseInt(process.env.TRANSFER_QUEUE_OWNER_TTL_MS || '10000'),
    ownerRefreshIntervalMs: parseInt(process.env.TRANSFER_QUEUE_OWNER_REFRESH_MS || '3000'),
    batchSize: parseInt(process.env.TRANSFER_QUEUE_BATCH_SIZE || '50'),
    readyQueueBlockTimeoutSec: parseInt(process.env.TRANSFER_QUEUE_BLOCK_TIMEOUT_SEC || '1'),
  };

  const userConfig = {};

  return {
    ...config,
    ...userConfig,
  };
};
