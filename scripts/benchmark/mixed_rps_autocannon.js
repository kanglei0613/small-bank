#!/usr/bin/env node
/**
 * mixed_rps_autocannon.js
 *
 * 混合請求壓測（autocannon 版本）
 *
 * 架構：
 * - 壓測前預先產生 POOL_SIZE 筆隨機請求
 * - 兩個 autocannon instance 分別對應 general API (7001) 和 transfer API (7010)
 * - 依照流量比例分配 connections：
 *     general:  75% (35+20+10+5+5)
 *     transfer: 25%
 *
 * 執行方式：
 *   node scripts/benchmark/mixed_rps_autocannon.js
 *   node scripts/benchmark/mixed_rps_autocannon.js --connections=200 --duration=30
 *   node scripts/benchmark/mixed_rps_autocannon.js --min-id=33288 --max-id=34288
 */

'use strict';

const ac = require('autocannon');

// =============================================================================
// 解析參數
// =============================================================================

const args = process.argv.slice(2).reduce((acc, arg) => {
  const [key, val] = arg.replace(/^--/, '').split('=');
  acc[key] = val;
  return acc;
}, {});

if ('help' in args || 'h' in args) {
  console.log(`
用法: node scripts/benchmark/mixed_rps_autocannon.js [選項]

選項：
  --connections=N      總並發連線數 (預設: 100)
  --duration=N         壓測時間秒數 (預設: 30)
  --pipelining=N       HTTP pipelining (預設: 1)
  --pool-size=N        預先產生的請求池大小 (預設: 1000)
  --min-id=N           帳號 ID 下限 (預設: 33288)
  --max-id=N           帳號 ID 上限 (預設: 136912)
  --min-user-id=N      用戶 ID 下限 (預設: 1)
  --max-user-id=N      用戶 ID 上限 (預設: 104042)
  --amount=N           transfer 金額 (預設: 1)
  --init-bal=N         帳號初始餘額 (預設: 10000)
  --general-url=URL    General API 位址 (預設: http://127.0.0.1:7001)
  --transfer-url=URL   Transfer API 位址 (預設: http://127.0.0.1:7010)
`);
  process.exit(0);
}

const GENERAL_URL  = args['general-url']  || 'http://127.0.0.1:7001';
const TRANSFER_URL = args['transfer-url'] || 'http://127.0.0.1:7010';
const AMOUNT       = parseInt(args['amount']   || '1');
const INIT_BAL     = parseInt(args['init-bal'] || '1000000');

// 讀取 seed 設定檔（由 seed.js 產生）
// 優先順序：命令列參數 > seed 設定檔 > 預設值
let seedConfig = {};
const SEED_CONFIG_FILE = args['seed-config'] || 'scripts/benchmark/.seed-config.json';
try {
  const fs = require('fs');
  if (fs.existsSync(SEED_CONFIG_FILE)) {
    seedConfig = JSON.parse(fs.readFileSync(SEED_CONFIG_FILE, 'utf8'));
    console.log(`  使用 seed 設定檔: ${SEED_CONFIG_FILE}`);
  }
} catch (e) {
  // 找不到設定檔，使用預設值
}

const MIN_ID      = parseInt(args['min-id']       || seedConfig.minId      || '1');
const MAX_ID      = parseInt(args['max-id']       || seedConfig.maxId      || '100000');
const MIN_USER_ID = parseInt(args['min-user-id']  || seedConfig.minUserId  || '1');
const MAX_USER_ID = parseInt(args['max-user-id']  || seedConfig.maxUserId  || '50000');
const CONNECTIONS  = parseInt(args['connections']  || '100');
const DURATION     = parseInt(args['duration']     || '30');
const PIPELINING   = parseInt(args['pipelining']   || '1');
const POOL_SIZE    = parseInt(args['pool-size']    || '1000');

const GENERAL_CONNS  = Math.max(1, Math.round(CONNECTIONS * 0.75));
const TRANSFER_CONNS = Math.max(1, CONNECTIONS - GENERAL_CONNS);

// =============================================================================
// 工具函式
// =============================================================================

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randAccountId() {
  return randInt(MIN_ID, MAX_ID);
}

function pickWeighted(weights) {
  const total = weights.reduce((s, w) => s + w.weight, 0);
  let r = Math.random() * total;
  for (const w of weights) {
    r -= w.weight;
    if (r <= 0) return w.name;
  }
  return weights[weights.length - 1].name;
}

const JSON_CT = { 'content-type': 'application/json' };

// =============================================================================
// 預先產生請求池
// =============================================================================

function buildGeneralRequests(size) {
  const requests = [];

  for (let i = 0; i < size; i++) {
    const action = pickWeighted([
      { name: 'getAccount',     weight: 35 },
      { name: 'getTransfers',   weight: 20 },
      { name: 'getTransferJob', weight: 10 },
      { name: 'postUser',       weight:  5 },
      { name: 'postAccount',    weight:  5 },
    ]);

    switch (action) {
      case 'getAccount':
        requests.push({
          method: 'GET',
          path: `/accounts/${randAccountId()}`,
        });
        break;

      case 'getTransfers':
        requests.push({
          method: 'GET',
          path: `/transfers?accountId=${randAccountId()}`,
        });
        break;

      case 'getTransferJob':
        // job pool 壓測初期是空的，fallback 到 getAccount
        requests.push({
          method: 'GET',
          path: `/accounts/${randAccountId()}`,
        });
        break;

      case 'postUser':
        requests.push({
          method: 'POST',
          path: '/users',
          headers: JSON_CT,
          body: JSON.stringify({ name: `bench-user-${randInt(1, 9999999)}` }),
        });
        break;

      case 'postAccount':
        requests.push({
          method: 'POST',
          path: '/accounts',
          headers: JSON_CT,
          body: JSON.stringify({
            userId: randInt(MIN_USER_ID, MAX_USER_ID),
            initialBalance: INIT_BAL,
          }),
        });
        break;

      default:
        requests.push({
          method: 'GET',
          path: `/accounts/${randAccountId()}`,
        });
    }
  }

  return requests;
}

function buildTransferRequests(size) {
  const requests = [];

  for (let i = 0; i < size; i++) {
    const fromId = randAccountId();
    let toId = randAccountId();
    while (toId === fromId) toId = randAccountId();

    requests.push({
      method: 'POST',
      path: '/transfers',
      headers: JSON_CT,
      body: JSON.stringify({ fromId, toId, amount: AMOUNT }),
    });
  }

  return requests;
}

// =============================================================================
// 啟動壓測
// =============================================================================

console.log('');
console.log('==========================================');
console.log('  混合請求壓測 (autocannon)');
console.log('==========================================');
console.log(`  connections  : ${CONNECTIONS} (general: ${GENERAL_CONNS}, transfer: ${TRANSFER_CONNS})`);
console.log(`  duration     : ${DURATION}s`);
console.log(`  pipelining   : ${PIPELINING}`);
console.log(`  pool size    : ${POOL_SIZE}`);
console.log(`  account IDs  : ${MIN_ID} – ${MAX_ID}`);
console.log(`  general url  : ${GENERAL_URL}`);
console.log(`  transfer url : ${TRANSFER_URL}`);
console.log('==========================================');
console.log('');
console.log('產生請求池...');

const generalRequests  = buildGeneralRequests(POOL_SIZE);
const transferRequests = buildTransferRequests(POOL_SIZE);

console.log(`  general requests : ${generalRequests.length}`);
console.log(`  transfer requests: ${transferRequests.length}`);
console.log('');

let generalResult  = null;
let transferResult = null;
let doneCount      = 0;

function onBothDone() {
  doneCount++;
  if (doneCount < 2) return;

  const totalReqs    = generalResult.requests.total + transferResult.requests.total;
  const totalErrors  = generalResult.errors + transferResult.errors;
  const totalTimeout = generalResult.timeouts + transferResult.timeouts;
  const avgRps       = generalResult.requests.average + transferResult.requests.average;

  const gw         = GENERAL_CONNS / CONNECTIONS;
  const tw         = TRANSFER_CONNS / CONNECTIONS;
  const avgLatency = (generalResult.latency.average * gw + transferResult.latency.average * tw).toFixed(2);
  const p95Latency = Math.max(generalResult.latency.p97_5 || 0, transferResult.latency.p97_5 || 0);
  const p99Latency = Math.max(generalResult.latency.p99 || 0, transferResult.latency.p99 || 0);

  console.log('');
  console.log('==========================================');
  console.log('  壓測結果');
  console.log('==========================================');
  console.log(`  總 RPS (avg)        : ${avgRps}`);
  console.log(`  General RPS         : ${generalResult.requests.average}`);
  console.log(`  Transfer RPS        : ${transferResult.requests.average}`);
  console.log(`  加權平均 latency    : ${avgLatency}ms`);
  console.log(`  p95 latency (worst) : ${p95Latency}ms`);
  console.log(`  p99 latency (worst) : ${p99Latency}ms`);
  console.log(`  Errors              : ${totalErrors}`);
  console.log(`  Timeouts            : ${totalTimeout}`);
  console.log(`  Total requests      : ${totalReqs}`);
  console.log('');
  console.log('  --- General API ---');
  console.log(`  RPS avg  : ${generalResult.requests.average}`);
  console.log(`  Latency  : avg=${generalResult.latency.average}ms p95=${generalResult.latency.p97_5}ms p99=${generalResult.latency.p99}ms`);
  console.log(`  Errors   : ${generalResult.errors}`);
  console.log(`  Timeouts : ${generalResult.timeouts}`);
  console.log('');
  console.log('  --- Transfer API ---');
  console.log(`  RPS avg  : ${transferResult.requests.average}`);
  console.log(`  Latency  : avg=${transferResult.latency.average}ms p95=${transferResult.latency.p97_5}ms p99=${transferResult.latency.p99}ms`);
  console.log(`  Errors   : ${transferResult.errors}`);
  console.log(`  Timeouts : ${transferResult.timeouts}`);
  console.log('==========================================');
}

const generalInstance = ac({
  url: GENERAL_URL,
  connections: GENERAL_CONNS,
  duration: DURATION,
  pipelining: PIPELINING,
  requests: generalRequests,
}, (err, result) => {
  if (err) console.error('General API 壓測失敗:', err);
  generalResult = result;
  onBothDone();
});

const transferInstance = ac({
  url: TRANSFER_URL,
  connections: TRANSFER_CONNS,
  duration: DURATION,
  pipelining: PIPELINING,
  requests: transferRequests,
}, (err, result) => {
  if (err) console.error('Transfer API 壓測失敗:', err);
  transferResult = result;
  onBothDone();
});

ac.track(generalInstance, { renderProgressBar: true, renderResultsTable: false });
ac.track(transferInstance, { renderProgressBar: true, renderResultsTable: false });
