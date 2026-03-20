#!/usr/bin/env node
/**
 * seed.js
 *
 * 壓測前置腳本：
 * 1. 清空 Redis
 * 2. 清空所有 DB 資料
 * 3. 建立指定數量的 user 和 account
 * 4. 輸出帳號 ID 範圍供壓測腳本使用
 *
 * 執行方式：
 *   node scripts/benchmark/seed.js
 *   node scripts/benchmark/seed.js --users=1000 --accounts-per-user=1 --init-bal=1000000
 *   node scripts/benchmark/seed.js --skip-flush   # 不清空資料，直接新增
 */

'use strict';

const { execSync } = require('child_process');

// =============================================================================
// 解析參數
// =============================================================================

const args = process.argv.slice(2).reduce((acc, arg) => {
  const [key, val] = arg.replace(/^--/, '').split('=');
  acc[key] = val === undefined ? true : val;
  return acc;
}, {});

const USERS             = parseInt(args['users']             || '50000');
const ACCOUNTS_PER_USER = parseInt(args['accounts-per-user'] || '1');
const INIT_BAL          = parseInt(args['init-bal']          || '1000000');
const CONCURRENCY       = parseInt(args['concurrency']       || '50');
const GENERAL_URL       = args['general-url']                || 'http://127.0.0.1:7001';
const SKIP_FLUSH        = !!args['skip-flush'];
const OUTPUT_FILE       = args['output']                     || 'scripts/benchmark/.seed-config.json';

const PG_DBS = [
  'small_bank_s0',
  'small_bank_s1',
  'small_bank_s2',
  'small_bank_s3',
];
const META_DB = 'small_bank_meta';

// =============================================================================
// 工具函式
// =============================================================================

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}

async function runConcurrent(tasks, concurrency) {
  const results = [];
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function progress(current, total, label) {
  const pct = Math.floor((current / total) * 100);
  const bar = '█'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5));
  process.stdout.write(`\r  ${label}: [${bar}] ${pct}% (${current}/${total})`);
  if (current === total) process.stdout.write('\n');
}

// =============================================================================
// 主流程
// =============================================================================

async function main() {
  console.log('');
  console.log('==========================================');
  console.log('  Small Bank Seed');
  console.log('==========================================');
  console.log(`  users          : ${USERS}`);
  console.log(`  accounts/user  : ${ACCOUNTS_PER_USER}`);
  console.log(`  initial balance: ${INIT_BAL}`);
  console.log(`  concurrency    : ${CONCURRENCY}`);
  console.log(`  general url    : ${GENERAL_URL}`);
  console.log(`  skip flush     : ${SKIP_FLUSH}`);
  console.log('==========================================');
  console.log('');

  // Step 1: flush
  if (!SKIP_FLUSH) {
    console.log('[ 1/4 ] 清空 Redis...');
    execSync('redis-cli FLUSHALL', { stdio: 'pipe' });
    console.log('        Redis 清空完成');

    console.log('[ 2/4 ] 清空資料庫...');
    for (const db of PG_DBS) {
      execSync(`psql -d ${db} -c "TRUNCATE accounts, transfers RESTART IDENTITY CASCADE;" 2>/dev/null || true`, { stdio: 'pipe' });
    }
    execSync(`psql -d ${META_DB} -c "TRUNCATE account_shards, users RESTART IDENTITY CASCADE;" 2>/dev/null || true`, { stdio: 'pipe' });
    execSync(`psql -d ${META_DB} -c "ALTER SEQUENCE global_account_id_seq RESTART WITH 1;" 2>/dev/null || true`, { stdio: 'pipe' });
    console.log('        資料庫清空完成');
  } else {
    console.log('[ 1/4 ] 跳過清空 Redis');
    console.log('[ 2/4 ] 跳過清空資料庫');
  }

  // Step 2: 建立 users
  console.log(`[ 3/4 ] 建立 ${USERS} 個 user...`);
  const userIds = [];
  let userDone = 0;

  const userTasks = Array.from({ length: USERS }, (_, i) => async () => {
    const res = await post(`${GENERAL_URL}/users`, {
      name: `bench-user-${i + 1}`,
    });
    userIds.push(res.data.id);
    userDone++;
    if (userDone % 500 === 0 || userDone === USERS) {
      progress(userDone, USERS, 'users');
    }
  });

  await runConcurrent(userTasks, CONCURRENCY);
  console.log(`        建立完成，user ID 範圍: ${Math.min(...userIds)} ~ ${Math.max(...userIds)}`);

  // Step 3: 建立 accounts
  const totalAccounts = USERS * ACCOUNTS_PER_USER;
  console.log(`[ 4/4 ] 建立 ${totalAccounts} 個 account...`);
  const accountIds = [];
  let accountDone = 0;

  const accountTasks = userIds.flatMap(userId =>
    Array.from({ length: ACCOUNTS_PER_USER }, () => async () => {
      const res = await post(`${GENERAL_URL}/accounts`, {
        userId,
        initialBalance: INIT_BAL,
      });
      accountIds.push(res.data.id);
      accountDone++;
      if (accountDone % 1000 === 0 || accountDone === totalAccounts) {
        progress(accountDone, totalAccounts, 'accounts');
      }
    })
  );

  await runConcurrent(accountTasks, CONCURRENCY);

  const minId = Math.min(...accountIds);
  const maxId = Math.max(...accountIds);
  const minUserId = Math.min(...userIds);
  const maxUserId = Math.max(...userIds);

  console.log('');
  console.log('==========================================');
  console.log('  Seed 完成');
  console.log('==========================================');
  console.log(`  總 users    : ${userIds.length}`);
  console.log(`  總 accounts : ${accountIds.length}`);
  console.log(`  account ID  : ${minId} ~ ${maxId}`);
  console.log(`  user ID     : ${minUserId} ~ ${maxUserId}`);
  console.log('');
  console.log('  壓測指令：');
  console.log(`  node scripts/benchmark/mixed_rps_autocannon.js \\`);
  console.log(`    --min-id=${minId} --max-id=${maxId} \\`);
  console.log(`    --min-user-id=${minUserId} --max-user-id=${maxUserId} \\`);
  console.log(`    --init-bal=${INIT_BAL}`);
  console.log('==========================================');

  // 輸出到檔案
  if (OUTPUT_FILE) {
    const fs = require('fs');
    const config = {
      minId, maxId,
      minUserId, maxUserId,
      initBal: INIT_BAL,
      totalAccounts: accountIds.length,
      totalUsers: userIds.length,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(config, null, 2));
    console.log(`\n  設定已寫入: ${OUTPUT_FILE}`);
  }
}

main().catch(err => {
  console.error('\n[seed] 失敗:', err.message);
  process.exit(1);
});
