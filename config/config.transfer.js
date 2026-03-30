'use strict';

module.exports = appInfo => {
  const config = exports = {};

  config.keys = appInfo.name + '_transfer';

  config.cluster = {
    listen: {
      port: 7002,
      hostname: '0.0.0.0',
    },
  };

  config.apiRole = 'transfer';
  config.workers = 2;

  return config;
};
