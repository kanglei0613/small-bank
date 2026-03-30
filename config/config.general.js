'use strict';

module.exports = appInfo => {
  const config = exports = {};

  config.keys = appInfo.name + '_general';

  config.cluster = {
    listen: {
      port: 7001,
      hostname: '0.0.0.0',
    },
  };

  config.apiRole = 'general';
  config.workers = 6;

  return config;
};
