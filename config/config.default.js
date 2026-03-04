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

  // PostgreSQL connection pool
  config.pg = {
    host: 'localhost',
    port: 5432,
    database: 'small_bank',
    max: 10, // 每個 worker 最多 10 connections
  };

  // Sharding: meta + shard pools
  config.pgMeta = {
    host: 'localhost',
    port: 5432,
    database: 'small_bank_meta',
    max: 2,
  };

  config.pgShards = [
    {
      host: 'localhost',
      port: 5432,
      database: 'small_bank_s0',
      max: 4,
    },
    {
      host: 'localhost',
      port: 5432,
      database: 'small_bank_s1',
      max: 4,
    },
  ];

  // 開啟 cluster workers
  config.cluster = {
    listen: {
      port: 7001,
      hostname: '127.0.0.1',
    },
    workers: 8,
  };

  const userConfig = {};

  return {
    ...config,
    ...userConfig,
  };
};
