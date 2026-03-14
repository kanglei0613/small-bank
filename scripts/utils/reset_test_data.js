'use strict';

/*
reset_test_data.js

用途：
重置測試資料，包含：

1. PostgreSQL table 清空
2. PostgreSQL id sequence 重置
3. Redis cache 清空

PostgreSQL:
- transfers
- accounts
- users

Redis:
- 清空目前 db (db 0)

注意：
這個腳本適合本地測試環境使用
不要拿去正式環境執行
*/

const { Client } = require('pg');
const Redis = require('ioredis');

// PostgreSQL connection
const pgClient = new Client({
  host: '127.0.0.1',
  port: 5432,
  user: 'kanglei0613',
  password: '',
  database: 'small_bank',
});

// Redis connection
const redis = new Redis({
  host: '127.0.0.1',
  port: 6379,
  password: '',
  db: 0,
});

// 重置 PostgreSQL 測試資料
async function resetPostgres() {
  console.log('Connecting to PostgreSQL...');

  await pgClient.connect();

  try {
    console.log('Resetting PostgreSQL data...');

    // 使用 TRUNCATE 清空資料並重置 ID
    await pgClient.query(`
      TRUNCATE TABLE
        transfers,
        accounts,
        users
      RESTART IDENTITY CASCADE
    `);

    console.log('PostgreSQL tables truncated.');
    console.log('PostgreSQL ID sequences reset.');
  } finally {
    await pgClient.end();
  }
}

// 重置 Redis 測試資料
async function resetRedis() {
  try {
    console.log('Resetting Redis data...');

    // 清空目前 Redis db
    await redis.flushdb();

    console.log('Redis db flushed.');
  } finally {
    await redis.quit();
  }
}

// 主流程
async function main() {
  try {
    console.log('========================================');
    console.log('Reset test data started');
    console.log('========================================');

    await resetPostgres();
    await resetRedis();

    console.log('========================================');
    console.log('Reset finished.');
    console.log('========================================');
  } catch (err) {
    console.error('Reset failed:', err);
    process.exit(1);
  }
}

main();
