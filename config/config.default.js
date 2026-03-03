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

  // 👇 加在這裡
  config.pg = {
    host: 'localhost',
    port: 5432,
    database: 'small_bank',
    // user: 'kanglei0613', // 如果連不上再打開
    max: 50,
  };

  const userConfig = {
    // myAppName: 'egg',
  };

  return {
    ...config,
    ...userConfig,
  };
};
