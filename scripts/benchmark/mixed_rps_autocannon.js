#!/usr/bin/env node
/**
 * mixed_rps_autocannon.js
 *
 * 混合請求壓測（autocannon 版本）
 * - 成功/失敗請求統計（HTTP 2xx = 成功）
 * - 壓測後餘額一致性檢查（針對有參與轉帳的帳號）
 *   ① 無負餘額
 *   ② 所有參與帳號的總餘額守恆（壓測前後 sum 不變）
 *
 * 執行方式：
 *   node scripts/benchmark/mixed_rps_autocannon.js
 *   node scripts/benchmark/mixed_rps_autocannon.js --connections=200 --duration=30
 *   node scripts/benchmark/mixed_rps_autocannon.js --min-id=33288 --max-id=34288
 */

'use strict';

const ac   = require('autocannon');
const http = require('http');

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
  --connections=N        總並發連線數 (預設: 100)
  --duration=N           壓測時間秒數 (預設: 30)
  --pipelining=N         HTTP pipelining (預設: 1)
  --pool-size=N          預先產生的請求池大小 (預設: 1000)
  --min-id=N             帳號 ID 下限 (預設: 1)
  --max-id=N             帳號 ID 上限 (預設: 100000)
  --min-user-id=N        用戶 ID 下限 (預設: 1)
  --max-user-id=N        用戶 ID 上限 (預設: 50000)
  --amount=N             transfer 金額 (預設: 1)
  --init-bal=N           帳號初始餘額 (預設: 1000000)
  --balance-sample=N     餘額檢查抽樣上限，0 = 全部 (預設: 200)
  --general-url=URL      General API 位址 (預設: http://127.0.0.1:7001)
  --transfer-url=URL     Transfer API 位址 (預設: http://127.0.0.1:7010)
  --balance-delay=N      壓測結束後等待 N 秒再做餘額檢查，排除跨 shard 延遲 (預設: 3)
  --queue-drain-timeout=N 等待 queue 清空的最大秒數，0 = 只等 balance-delay (預設: 120)
  --skip-balance-check   跳過餘額一致性檢查
`);
  process.exit(0);
}

const GENERAL_URL        = args['general-url']        || 'http://127.0.0.1:7001';
const TRANSFER_URL       = args['transfer-url']       || 'http://127.0.0.1:7010';
const AMOUNT             = parseInt(args['amount']          || '1');
const INIT_BAL           = parseInt(args['init-bal']        || '1000000');
const BALANCE_SAMPLE     = parseInt(args['balance-sample']  || '200');
const BALANCE_DELAY      = parseInt(args['balance-delay']   || '3');
const QUEUE_DRAIN_TIMEOUT = parseInt(args['queue-drain-timeout'] || '120');
const REDIS_URL          = args['redis-url'] || '127.0.0.1';
const REDIS_PORT         = parseInt(args['redis-port'] || '6379');
const SKIP_BALANCE_CHECK = 'skip-balance-check' in args;

// PG shard 設定（用於全量餘額查詢）
const PG_SHARDS = (args['pg-shards'] || 'small_bank_s0,small_bank_s1,small_bank_s2,small_bank_s3').split(',');
const PG_HOST   = args['pg-host'] || '127.0.0.1';
const PG_PORT   = parseInt(args['pg-port'] || '5432');
const PG_USER   = args['pg-user'] || process.env.USER || 'postgres';

// 讀取 seed 設定檔
let seedConfig = {};
const SEED_CONFIG_FILE = args['seed-config'] || 'scripts/benchmark/.seed-config.json';
try {
  const fs = require('fs');
  if (fs.existsSync(SEED_CONFIG_FILE)) {
    seedConfig = JSON.parse(fs.readFileSync(SEED_CONFIG_FILE, 'utf8'));
    console.log(`  使用 seed 設定檔: ${SEED_CONFIG_FILE}`);
  }
} catch (_) {}

const MIN_ID      = parseInt(args['min-id']      || seedConfig.minId      || '1');
const MAX_ID      = parseInt(args['max-id']      || seedConfig.maxId      || '100000');
const MIN_USER_ID = parseInt(args['min-user-id'] || seedConfig.minUserId  || '1');
const MAX_USER_ID = parseInt(args['max-user-id'] || seedConfig.maxUserId  || '50000');
const CONNECTIONS = parseInt(args['connections'] || '100');
const DURATION    = parseInt(args['duration']    || '30');
const PIPELINING  = parseInt(args['pipelining']  || '1');
const POOL_SIZE   = parseInt(args['pool-size']   || '1000');

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
// 成功率計算
// =============================================================================

/**
 * autocannon result 欄位說明：
 *   result.requests.total  總請求數
 *   result.non2xx          HTTP 4xx + 5xx 回應數
 *   result.errors          連線/網路層錯誤數（含 timeouts）
 *   result.timeouts        逾時數（已包含在 errors 內）
 *
 * 成功 = HTTP 2xx 且無連線錯誤
 * failCount = non2xx + errors（errors 已含 timeouts，不重複扣）
 */
function calcStats(result, label) {
  const total    = result.requests.total || 0;
  const non2xx   = result.non2xx         || 0;
  const errors   = result.errors         || 0;
  const timeouts = result.timeouts       || 0;

  const failCount    = non2xx + errors;
  const successCount = Math.max(0, total - failCount);
  const successRate  = total > 0 ? ((successCount / total) * 100).toFixed(2) : '0.00';
  const failRate     = total > 0 ? ((failCount    / total) * 100).toFixed(2) : '0.00';

  return { label, total, successCount, failCount, non2xx, errors, timeouts, successRate, failRate };
}

function printStats(s) {
  console.log(`  成功請求數  : ${s.successCount} / ${s.total}  (${s.successRate}%)`);
  console.log(`  失敗請求數  : ${s.failCount} / ${s.total}  (${s.failRate}%)`);
  console.log(`    └ HTTP 4xx/5xx : ${s.non2xx}`);
  console.log(`    └ 連線錯誤     : ${s.errors}  (含逾時 ${s.timeouts})`);
}

// =============================================================================
// 全量餘額守恆查詢（直接查 PostgreSQL）
// =============================================================================

/**
 * 用 psql 指令查詢單一 shard 的帳號總餘額
 * 只計算 seed 範圍內的帳號（MIN_ID ~ MAX_ID），排除壓測期間 postAccount 新建的
 */
function queryShardBalance(dbName, retries = 5) {
  const { execSync } = require('child_process');
  for (let i = 0; i < retries; i++) {
    try {
      const sql = `SELECT COALESCE(SUM(balance), 0) AS total, COALESCE(SUM(reserved_balance), 0) AS reserved FROM accounts WHERE id >= ${MIN_ID} AND id <= ${MAX_ID};`;
      const cmd = `psql -h ${PG_HOST} -p ${PG_PORT} -U ${PG_USER} -d ${dbName} -t -A -c "${sql}"`;
      const output = execSync(cmd, { timeout: 15000 }).toString().trim();
      const parts = output.split('|');
      return {
        balance:  BigInt(parts[0] || '0'),
        reserved: BigInt(parts[1] || '0'),
      };
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('too many clients') && i < retries - 1) {
        // 等待連線釋放後重試
        const waitMs = (i + 1) * 3000;
        const { execSync: execSyncWait } = require('child_process');
        try { execSyncWait(`sleep ${waitMs / 1000}`); } catch (_) {}
        continue;
      }
      return null;
    }
  }
  return null;
}

/**
 * 查詢所有 shard 的總餘額，驗證守恆
 * 預期總額 = totalAccounts × INIT_BAL
 */
async function checkFullBalanceConsistency() {
  const totalAccounts = seedConfig.totalAccounts || (MAX_ID - MIN_ID + 1);
  const expectedTotal = BigInt(totalAccounts) * BigInt(seedConfig.initBal || INIT_BAL);

  // 等待 PG 連線數降到安全範圍
  const PG_CONN_THRESHOLD = parseInt(args['pg-conn-threshold'] || '50');
  const PG_CONN_TIMEOUT   = parseInt(args['pg-conn-wait-timeout'] || '120');
  const pgConnStart = Date.now();

  process.stdout.write('  等待 PG 連線釋放...');
  while (true) {
    try {
      const { execSync } = require('child_process');
      const connCount = execSync(
        `psql -h ${PG_HOST} -p ${PG_PORT} -U ${PG_USER} -d ${PG_SHARDS[0]} -t -A -c "SELECT count(*) FROM pg_stat_activity WHERE state IS NOT NULL;"`,
        { timeout: 5000 }
      ).toString().trim();
      const count = parseInt(connCount || '999');
      if (count < PG_CONN_THRESHOLD) {
        console.log(` 完成（${count} 條）`);
        break;
      }
    } catch (_) {}
    if (Date.now() - pgConnStart > PG_CONN_TIMEOUT * 1000) {
      console.log(' 逾時，強制查詢');
      break;
    }
    await new Promise(r => setTimeout(r, 3000));
  }

  let totalBalance  = 0n;
  let totalReserved = 0n;
  let queryFailed   = false;

  for (const db of PG_SHARDS) {
    const result = queryShardBalance(db);
    if (!result) {
      queryFailed = true;
      continue;
    }
    totalBalance  += result.balance;
    totalReserved += result.reserved;
  }

  console.log('');
  console.log('==========================================');
  console.log('  全量餘額守恆查詢');
  console.log('==========================================');

  if (queryFailed) {
    console.log('  ⚠️  部分 shard 查詢失敗，結果不完整');
    console.log('==========================================');
    return;
  }

  const balanceDiff = totalBalance - expectedTotal;

  console.log(`  預期總額        : ${expectedTotal}`);
  console.log(`  實際總餘額      : ${totalBalance}`);
  if (totalReserved > 0n) {
    console.log(`  Reserved 餘額   : ${totalReserved}`);
    const adjustedDiff = (totalBalance + totalReserved) - expectedTotal;
    console.log(`  差值（含reserved）: ${adjustedDiff >= 0n ? '+' : ''}${adjustedDiff}`);
    if (adjustedDiff === 0n) {
      console.log('  ✅ 總餘額守恆（含 reserved）');
    } else {
      console.log('  ❌ 總餘額不一致！');
    }
  } else {
    console.log(`  差值            : ${balanceDiff >= 0n ? '+' : ''}${balanceDiff}`);
    if (balanceDiff === 0n) {
      console.log('  ✅ 全量餘額完全守恆');
    } else {
      console.log('  ❌ 全量餘額不一致！');
    }
  }
  console.log('==========================================');
}

// =============================================================================
// 等待 Redis queue 清空
// =============================================================================

/**
 * 用 net 模組直接連 Redis，查 transfer:queue:* 的 key 數量
 * 避免需要安裝 ioredis/redis npm 套件
 */
function redisCommand(command) {
  const net = require('net');
  return new Promise((resolve, reject) => {
    const client = net.createConnection(REDIS_PORT, REDIS_URL);
    let data = '';
    client.setTimeout(5000);
    client.on('connect', () => { client.write(command); });
    client.on('data', (chunk) => {
      data += chunk.toString();
      // 簡單判斷回應是否完整（以 \r\n 結尾）
      if (data.includes('\r\n')) {
        client.destroy();
        resolve(data);
      }
    });
    client.on('timeout', () => { client.destroy(); reject(new Error('redis timeout')); });
    client.on('error', reject);
  });
}

async function getQueueLength() {
  try {
    // KEYS transfer:queue:* 取得所有 queue key 數量
    const resp = await redisCommand('*2\r\n$4\r\nKEYS\r\n$17\r\ntransfer:queue:*\r\n');
    // 解析 RESP array 長度（*N）
    const match = resp.match(/^\*(\d+)/);
    return match ? parseInt(match[1]) : 0;
  } catch (_) {
    return -1; // 查詢失敗，回傳 -1 表示無法確認
  }
}

/**
 * 等待 queue 完全清空
 * - 每 2 秒查一次 queue key 數量
 * - 連續 3 次為 0 才確認清空（避免短暫空檔誤判）
 * - 無上限，等到真的清完為止
 * - 只顯示最終結果，不顯示過程
 */
async function waitForQueueDrain() {
  const start = Date.now();
  let zeroCount = 0;

  process.stdout.write('\n  等待所有 transfer job 完成...');

  while (true) {
    await new Promise(r => setTimeout(r, 2000));

    if (QUEUE_DRAIN_TIMEOUT > 0) {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      if (elapsed >= QUEUE_DRAIN_TIMEOUT) {
        console.log(` 逾時（${elapsed}s），強制繼續`);
        return;
      }
    }

    const len = await getQueueLength();

    if (len <= 0) {
      zeroCount++;
      if (zeroCount >= 3) {
        const elapsed = Math.floor((Date.now() - start) / 1000);
        console.log(` 完成（${elapsed}s）`);
        return;
      }
    } else {
      zeroCount = 0;
    }
  }
}

// =============================================================================
// 餘額一致性檢查（HTTP）
// =============================================================================

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, body });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
  });
}

/**
 * 查詢一組帳號的餘額，回傳 Map<id, balance>
 * 若查詢失敗則該帳號不加入 map
 */
async function fetchBalances(accountIds, concurrency = 20) {
  const balanceMap = new Map();
  const ids = [...accountIds];

  for (let i = 0; i < ids.length; i += concurrency) {
    const batch = ids.slice(i, i + concurrency);
    await Promise.all(batch.map(async (id) => {
      try {
        const { status, body } = await httpGet(`${GENERAL_URL}/accounts/${id}`);
        // response: { ok: true, data: { balance: "1000000", ... } }
        if (status === 200 && body && body.ok && body.data && body.data.balance !== undefined) {
          balanceMap.set(id, Number(body.data.balance));
        }
      } catch (_) {
        // 查詢失敗略過
      }
    }));
  }

  return balanceMap;
}

/**
 * 餘額一致性檢查主流程
 * @param {Set<number>} involvedIds  - 有參與轉帳的帳號 ID 集合
 * @param {Map<number,number>} preBalances - 壓測前餘額快照
 */
async function checkBalanceConsistency(involvedIds, preBalances) {
  console.log('');
  console.log('==========================================');
  console.log('  餘額一致性檢查');
  console.log('==========================================');

  // 只查壓測前有快照的帳號，確保壓測前後比對基準一致
  // （避免壓測後查了更多帳號，導致大量 pre=undefined 被誤判為新建帳號）
  const checkIds = [...preBalances.keys()];
  console.log(`  檢查帳號數  : ${checkIds.length}（壓測前快照帳號）`);

  // 壓測後餘額
  process.stdout.write('  查詢壓測後餘額中...');
  const postBalances = await fetchBalances(checkIds);
  console.log(` 完成 (${postBalances.size}/${checkIds.length})`);

  let negativeCount  = 0;
  let missingCount   = 0;
  const negativeList = [];
  let preSum  = 0n;
  let postSum = 0n;

  for (const id of checkIds) {
    const pre  = preBalances.get(id);
    const post = postBalances.get(id);

    if (post === undefined) {
      missingCount++;
      continue;
    }

    // ① 不能是負餘額
    if (post < 0) {
      negativeCount++;
      negativeList.push({ id, balance: post });
    }

    // ② 守恆計算（pre 一定存在，因為 checkIds 來自 preBalances）
    preSum  += BigInt(Math.round(pre));
    postSum += BigInt(Math.round(post));
  }

  // 總餘額守恆檢查
  const sumDiff = postSum - preSum;

  console.log('');
  console.log('  【① 負餘額檢查】');
  if (negativeCount === 0) {
    console.log(`  ✅ 無負餘額  (共檢查 ${checkIds.length - missingCount} 個帳號)`);
  } else {
    console.log(`  ❌ 發現負餘額帳號: ${negativeCount} 個`);
    negativeList.slice(0, 10).forEach(({ id, balance }) => {
      console.log(`     帳號 ${id}: balance = ${balance}`);
    });
    if (negativeList.length > 10) {
      console.log(`     ... 以及其他 ${negativeList.length - 10} 個`);
    }
  }

  console.log('');
  console.log('  【② 總餘額守恆檢查（抽樣帳號）】');
  console.log(`  比對帳號數  : ${checkIds.length - missingCount}`);
  console.log(`  壓測前總和  : ${preSum}`);
  console.log(`  壓測後總和  : ${postSum}`);
  console.log(`  差值        : ${sumDiff >= 0n ? '+' : ''}${sumDiff}`);
  if (sumDiff === 0n) {
    console.log('  ✅ 總餘額守恆');
  } else {
    console.log('  ❌ 總餘額不一致！');
    console.log('     可能原因：跨 shard 轉帳存在最終一致性延遲，或有資金丟失/重複計算');
  }

  if (missingCount > 0) {
    console.log('');
    console.log(`  ⚠️  有 ${missingCount} 個帳號查詢失敗（可能已被刪除或 API 不可用）`);
  }

  console.log('==========================================');

  return {
    checked: checkIds.length,
    missing: missingCount,
    negativeCount,
    sumConsistent: sumDiff === 0n,
    sumDiff: sumDiff.toString(),
  };
}

// =============================================================================
// 預先產生請求池，同時記錄參與轉帳的帳號
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
        requests.push({ method: 'GET', path: `/accounts/${randAccountId()}` });
        break;
      case 'getTransfers':
        requests.push({ method: 'GET', path: `/transfers?accountId=${randAccountId()}` });
        break;
      case 'getTransferJob':
        requests.push({ method: 'GET', path: `/accounts/${randAccountId()}` });
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
          body: JSON.stringify({ userId: randInt(MIN_USER_ID, MAX_USER_ID), initialBalance: INIT_BAL }),
        });
        break;
      default:
        requests.push({ method: 'GET', path: `/accounts/${randAccountId()}` });
    }
  }

  return requests;
}

/**
 * 建立 transfer 請求池，同時回傳參與轉帳的帳號 ID 集合
 * @returns {{ requests: Array, involvedIds: Set<number> }}
 */
function buildTransferRequests(size) {
  const requests   = [];
  const involvedIds = new Set();

  for (let i = 0; i < size; i++) {
    const fromId = randAccountId();
    let toId = randAccountId();
    while (toId === fromId) toId = randAccountId();

    involvedIds.add(fromId);
    involvedIds.add(toId);

    requests.push({
      method: 'POST',
      path: '/transfers',
      headers: JSON_CT,
      body: JSON.stringify({ fromId, toId, amount: AMOUNT }),
    });
  }

  return { requests, involvedIds };
}

// =============================================================================
// 主流程
// =============================================================================

(async () => {
  console.log('');
  console.log('==========================================');
  console.log('  混合請求壓測 (autocannon)');
  console.log('==========================================');
  console.log(`  connections  : ${CONNECTIONS} (general: ${GENERAL_CONNS}, transfer: ${TRANSFER_CONNS})`);
  console.log(`  duration     : ${DURATION}s`);
  console.log(`  pool size    : ${POOL_SIZE}`);
  console.log(`  account IDs  : ${MIN_ID} – ${MAX_ID}`);
  console.log(`  general url  : ${GENERAL_URL}`);
  console.log(`  transfer url : ${TRANSFER_URL}`);
  console.log('==========================================');
  console.log('');

  const generalRequests                          = buildGeneralRequests(POOL_SIZE);
  const { requests: transferRequests, involvedIds } = buildTransferRequests(POOL_SIZE);

  console.log('開始壓測...');

  // --------------------------------------------------
  // 壓測
  // --------------------------------------------------
  const runAc = (opts) => new Promise((resolve, reject) => {
    const instance = ac(opts, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
    ac.track(instance, { renderProgressBar: true, renderResultsTable: false });
  });

  const [generalResult, transferResult] = await Promise.all([
    runAc({
      url: GENERAL_URL,
      connections: GENERAL_CONNS,
      duration: DURATION,
      pipelining: PIPELINING,
      requests: generalRequests,
    }),
    runAc({
      url: TRANSFER_URL,
      connections: TRANSFER_CONNS,
      duration: DURATION,
      pipelining: PIPELINING,
      requests: transferRequests,
    }),
  ]);

  // --------------------------------------------------
  // 結果匯整
  // --------------------------------------------------
  const gStats = calcStats(generalResult,  'General API');
  const tStats = calcStats(transferResult, 'Transfer API');

  const totalReqs      = gStats.total    + tStats.total;
  const totalSuccess   = gStats.successCount + tStats.successCount;
  const totalFail      = gStats.failCount    + tStats.failCount;
  const overallSuccess = totalReqs > 0 ? ((totalSuccess / totalReqs) * 100).toFixed(2) : '0.00';
  const overallFail    = totalReqs > 0 ? ((totalFail    / totalReqs) * 100).toFixed(2) : '0.00';
  const avgRps         = gStats.total > 0 ? (generalResult.requests.average  || 0) : 0;
  const tRps           = tStats.total > 0 ? (transferResult.requests.average || 0) : 0;

  const gw         = GENERAL_CONNS / CONNECTIONS;
  const tw         = TRANSFER_CONNS / CONNECTIONS;
  const avgLatency = (generalResult.latency.average * gw + transferResult.latency.average * tw).toFixed(2);
  const p95Latency = Math.max(generalResult.latency.p97_5 || 0, transferResult.latency.p97_5 || 0);
  const p99Latency = Math.max(generalResult.latency.p99   || 0, transferResult.latency.p99   || 0);

  console.log('');
  console.log('==========================================');
  console.log('  壓測結果');
  console.log('==========================================');
  console.log(`  總 RPS (avg)        : ${avgRps + tRps}`);
  console.log(`  加權平均 latency    : ${avgLatency}ms`);
  console.log(`  p95 latency (worst) : ${p95Latency}ms`);
  console.log(`  p99 latency (worst) : ${p99Latency}ms`);
  console.log('');
  console.log('  【整體成功率】');
  console.log(`  總請求數    : ${totalReqs}`);
  console.log(`  成功請求數  : ${totalSuccess}  (${overallSuccess}%)`);
  console.log(`  失敗請求數  : ${totalFail}  (${overallFail}%)`);

  console.log('');
  console.log('  --- General API ---');
  console.log(`  RPS avg  : ${generalResult.requests.average}`);
  console.log(`  Latency  : avg=${generalResult.latency.average}ms  p95=${generalResult.latency.p97_5}ms  p99=${generalResult.latency.p99}ms`);
  printStats(gStats);

  console.log('');
  console.log('  --- Transfer API ---');
  console.log(`  RPS avg  : ${transferResult.requests.average}`);
  console.log(`  Latency  : avg=${transferResult.latency.average}ms  p95=${transferResult.latency.p97_5}ms  p99=${transferResult.latency.p99}ms`);
  printStats(tStats);
  console.log('==========================================');

  // --------------------------------------------------
  // 餘額一致性檢查：等所有 job 跑完後再查
  // --------------------------------------------------
  if (!SKIP_BALANCE_CHECK) {
    await waitForQueueDrain();
    await checkFullBalanceConsistency();
  }
})();
