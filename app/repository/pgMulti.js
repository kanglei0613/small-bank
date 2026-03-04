'use strict';

const { Pool } = require('pg');

const pools = new Map();

function getNamedPool(name, cfg) {
  if (pools.has(name)) return pools.get(name);
  const pool = new Pool(cfg);
  pools.set(name, pool);
  return pool;
}

module.exports = { getNamedPool };
