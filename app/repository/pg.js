'use strict';

const { Pool } = require('pg');

let pool;

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
