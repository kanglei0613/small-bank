#!/usr/bin/env node
/**
 * mixed_rps_ab.js
 *
 * 混合請求壓測（Apache Benchmark ab 版本）
 * - 成功/失敗請求統計（HTTP 2xx = 成功）
 * - 壓測後全量餘額守恆查詢（PostgreSQL）
 *
 * Transfer 多樣化設計：
 *   ab 只支援單一 URL + 單一 body，因此起多個 ab process
 *   每個 process 使用不同的 fromId/toId，模擬隨機轉帳
 *   --transfer-pairs=N 控制幾組帳號對（預設: 20）
 *
 * General：固定打 GET /accounts/:id（隨機選一個帳號）
 *
 * 前置需求：系統已安裝 ab
 *   macOS:  brew install httpd  → export PATH="/opt/homebrew/opt/httpd/bin:$PATH"
 *   Ubuntu: sudo apt install apache2-utils
 *
 * 執行方式：
 *   node scripts/benchmark/mixed_rps_ab.js
 *   node scripts/benchmark/mixed_rps_ab.js --connections=200 --duration=30
 *   node scripts/benchmark/mixed_rps_ab.js --connections=1000 --transfer-pairs=50
 */

'use strict';

const { spawn }  = require('child_process');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');

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
用法: node scripts/benchmark/mixed_rps_ab.js [選項]

選項：
  --connections=N          總並發連線數 (預設: 100)
  --duration=N             壓測時間秒數 (預設: 30)
  --transfer-pairs=N       Transfer 帳號對數量，每對起一個 ab (預設: 20)
  --min-id=N               帳號 ID 下限 (預設: 1)
  --max-id=N               帳號 ID 上限 (預設: 100000)
  --amount=N               transfer 金額 (預設: 1)
  --init-bal=N             帳號初始餘額 (預設: 1000000)
  --general-url=URL        General API 位址 (預設: http://127.0.0.1:7001)
  --transfer-url=URL       Transfer API 位址 (預設: http://127.0.0.1:7010)
  --pg-shards=a,b,c,d      PG shard DB 名稱 (預設: small_bank_s0,...,s3)
  --pg-host=HOST           PG 主機 (預設: 127.0.0.1)
  --pg-port=N              PG 埠 (預設: 5432)
  --pg-user=USER           PG 使用者 (預設: 系統使用者)
  --pg-conn-threshold=N    等 PG 連線數低於此值再查餘額 (預設: 50)
  --redis-url=HOST         Redis 主機 (預設: 127.0.0.1)
  --redis-port=N           Redis 埠 (預設: 6379)
  --ab-path=PATH           ab 執行檔路徑 (預設: ab)
  --skip-balance-check     跳過餘額一致性檢查
`);
  process.exit(0);
}

const GENERAL_URL        = args['general-url']  || 'http://127.0.0.1:7001';
const TRANSFER_URL       = args['transfer-url'] || 'http://127.0.0.1:7010';
const AMOUNT             = parseInt(args['amount']         || '1');
const INIT_BAL           = parseInt(args['init-bal']       || '1000000');
const TRANSFER_PAIRS     = parseInt(args['transfer-pairs'] || '20');
const SKIP_BALANCE_CHECK = 'skip-balance-check' in args;
const AB_PATH            = args['ab-path']   || 'ab';
const REDIS_URL          = args['redis-url'] || '127.0.0.1';
const REDIS_PORT         = parseInt(args['redis-port'] || '6379');

const PG_SHARDS = (args['pg-shards'] || 'small_bank_s0,small_bank_s1,small_bank_s2,small_bank_s3').split(',');
const PG_HOST   = args['pg-host'] || '127.0.0.1';
const PG_PORT   = parseInt(args['pg-port'] || '5432');
const PG_USER   = args['pg-user'] || process.env.USER || 'postgres';

// 讀取 seed 設定檔
let seedConfig = {};
const SEED_CONFIG_FILE = args['seed-config'] || 'scripts/benchmark/.seed-config.json';
try {
  if (fs.existsSync(SEED_CONFIG_FILE)) {
    seedConfig = JSON.parse(fs.readFileSync(SEED_CONFIG_FILE, 'utf8'));
    console.log(`  使用 seed 設定檔: ${SEED_CONFIG_FILE}`);
  }
} catch (_) {}

const MIN_ID      = parseInt(args['min-id']      || seedConfig.minId || '1');
const MAX_ID      = parseInt(args['max-id']      || seedConfig.maxId || '100000');
const CONNECTIONS = parseInt(args['connections'] || '100');
const DURATION    = parseInt(args['duration']    || '30');

// 連線數分配：75% general，25% transfer 平均分給每個 pair
const GENERAL_CONC       = Math.max(1, Math.round(CONNECTIONS * 0.75));
const TRANSFER_TOTAL_CONC = Math.max(1, CONNECTIONS - GENERAL_CONC);
// 每個 transfer pair 的 concurrency（至少 1）
const TRANSFER_PAIR_CONC = Math.max(1, Math.floor(TRANSFER_TOTAL_CONC / TRANSFER_PAIRS));

// =============================================================================
// 工具函式
// =============================================================================

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randAccountId() {
  return randInt(MIN_ID, MAX_ID);
}

// 產生 N 組不重複的 fromId/toId
function buildTransferPairs(n) {
  const pairs = [];
  const usedFromIds = new Set();

  for (let i = 0; i < n; i++) {
    let fromId = randAccountId();
    // 盡量避免重複的 fromId
    let attempts = 0;
    while (usedFromIds.has(fromId) && attempts < 10) {
      fromId = randAccountId();
      attempts++;
    }
    usedFromIds.add(fromId);

    let toId = randAccountId();
    while (toId === fromId) toId = randAccountId();

    pairs.push({ fromId, toId });
  }
  return pairs;
}

// =============================================================================
// 解析 ab 輸出
// =============================================================================

function parseAbOutput(stdout) {
  const get = (pattern) => {
    const m = stdout.match(pattern);
    return m ? m[1].trim() : null;
  };

  const complete  = parseInt(get(/Complete requests:\s+(\d+)/)    || '0');
  const failed    = parseInt(get(/Failed requests:\s+(\d+)/)      || '0');
  const non2xx    = parseInt(get(/Non-2xx responses:\s+(\d+)/)    || '0');
  const totalReqs = complete + failed;

  const successCount = Math.max(0, complete - non2xx);
  const failCount    = failed + non2xx;
  const successRate  = totalReqs > 0 ? ((successCount / totalReqs) * 100).toFixed(2) : '0.00';
  const failRate     = totalReqs > 0 ? ((failCount    / totalReqs) * 100).toFixed(2) : '0.00';

  return {
    totalReqs,
    complete,
    failed,
    non2xx,
    successCount,
    failCount,
    successRate,
    failRate,
    rps:         parseFloat(get(/Requests per second:\s+([\d.]+)/)                  || '0'),
    meanLatency: parseFloat(get(/Time per request:\s+([\d.]+)\s+\[ms\] \(mean\)/)  || '0'),
    p50:         parseFloat(get(/\s+50\s+(\d+)/)  || '0'),
    p95:         parseFloat(get(/\s+95\s+(\d+)/)  || '0'),
    p99:         parseFloat(get(/\s+99\s+(\d+)/)  || '0'),
  };
}

// 合併多個 ab 結果
function mergeAbResults(results) {
  const valid = results.filter(Boolean);
  if (valid.length === 0) return null;

  const totalReqs    = valid.reduce((s, r) => s + r.totalReqs,    0);
  const complete     = valid.reduce((s, r) => s + r.complete,     0);
  const failed       = valid.reduce((s, r) => s + r.failed,       0);
  const non2xx       = valid.reduce((s, r) => s + r.non2xx,       0);
  const successCount = valid.reduce((s, r) => s + r.successCount, 0);
  const failCount    = valid.reduce((s, r) => s + r.failCount,    0);
  const rps          = valid.reduce((s, r) => s + r.rps,          0);

  // 加權平均 latency（以各 process 的 totalReqs 為權重）
  const meanLatency = totalReqs > 0
    ? valid.reduce((s, r) => s + r.meanLatency * r.totalReqs, 0) / totalReqs
    : 0;

  // p95/p99 取最大值（最壞情況）
  const p95 = Math.max(...valid.map(r => r.p95));
  const p99 = Math.max(...valid.map(r => r.p99));

  const successRate = totalReqs > 0 ? ((successCount / totalReqs) * 100).toFixed(2) : '0.00';
  const failRate    = totalReqs > 0 ? ((failCount    / totalReqs) * 100).toFixed(2) : '0.00';

  return {
    totalReqs, complete, failed, non2xx,
    successCount, failCount, successRate, failRate,
    rps, meanLatency: parseFloat(meanLatency.toFixed(3)),
    p50: Math.max(...valid.map(r => r.p50)),
    p95, p99,
  };
}

// =============================================================================
// 執行單一 ab 實例
// =============================================================================

function runAb(opts) {
  return new Promise((resolve) => {
    const abArgs = [
      '-c', String(opts.concurrency),
      '-k',
      '-t', String(opts.timelimit),
      '-n', '2147483647',
    ];

    if (opts.method === 'POST') {
      abArgs.push(
        '-p', opts.postFile,
        '-T', opts.contentType || 'application/json',
      );
    }

    abArgs.push(opts.url);

    const proc = spawn(AB_PATH, abArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0 && !stdout.includes('Complete requests')) {
        if (opts.verbose) {
          console.error(`  [${opts.label}] ab 失敗 (exit ${code}): ${stderr.slice(0, 200)}`);
        }
        return resolve(null);
      }
      resolve(parseAbOutput(stdout));
    });

    proc.on('error', (err) => {
      console.error(`  無法執行 ab: ${err.message}`);
      console.error('  請確認已安裝 ab，或用 --ab-path 指定路徑');
      resolve(null);
    });
  });
}

// =============================================================================
// printStats（與 autocannon 版輸出格式一致）
// =============================================================================

function printAbStats(r) {
  if (!r) {
    console.log('  （無結果，ab 可能執行失敗）');
    return;
  }
  console.log(`  成功請求數  : ${r.successCount} / ${r.totalReqs}  (${r.successRate}%)`);
  console.log(`  失敗請求數  : ${r.failCount} / ${r.totalReqs}  (${r.failRate}%)`);
  console.log(`    └ HTTP 4xx/5xx : ${r.non2xx}`);
  console.log(`    └ 連線錯誤     : ${r.failed}`);
}

// =============================================================================
// 等待 Redis queue 清空
// =============================================================================

function redisCommand(command) {
  const net = require('net');
  return new Promise((resolve, reject) => {
    const client = net.createConnection(REDIS_PORT, REDIS_URL);
    let data = '';
    client.setTimeout(5000);
    client.on('connect', () => { client.write(command); });
    client.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\r\n')) { client.destroy(); resolve(data); }
    });
    client.on('timeout', () => { client.destroy(); reject(new Error('redis timeout')); });
    client.on('error', reject);
  });
}

async function getQueueLength() {
  try {
    const resp = await redisCommand('*2\r\n$4\r\nKEYS\r\n$16\r\ntransfer:queue:*\r\n');
    const match = resp.match(/^\*(\d+)/);
    return match ? parseInt(match[1]) : 0;
  } catch (_) {
    return -1;
  }
}

async function waitForQueueDrain() {
  const start = Date.now();
  let zeroCount = 0;

  process.stdout.write('\n  等待所有 transfer job 完成...');

  while (true) {
    await new Promise(r => setTimeout(r, 2000));
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
// 全量餘額守恆查詢（PostgreSQL）
// =============================================================================

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
        try { require('child_process').execSync(`sleep ${(i + 1) * 3}`); } catch (_) {}
        continue;
      }
      return null;
    }
  }
  return null;
}

async function checkFullBalanceConsistency() {
  const totalAccounts = seedConfig.totalAccounts || (MAX_ID - MIN_ID + 1);
  const expectedTotal = BigInt(totalAccounts) * BigInt(seedConfig.initBal || INIT_BAL);

  const PG_CONN_THRESHOLD = parseInt(args['pg-conn-threshold']    || '50');
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
      if (count < PG_CONN_THRESHOLD) { console.log(` 完成（${count} 條）`); break; }
    } catch (_) {}
    if (Date.now() - pgConnStart > PG_CONN_TIMEOUT * 1000) { console.log(' 逾時，強制查詢'); break; }
    await new Promise(r => setTimeout(r, 3000));
  }

  let totalBalance  = 0n;
  let totalReserved = 0n;
  let queryFailed   = false;

  for (const db of PG_SHARDS) {
    const result = queryShardBalance(db);
    if (!result) { queryFailed = true; continue; }
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
    console.log(adjustedDiff === 0n ? '  ✅ 總餘額守恆（含 reserved）' : '  ❌ 總餘額不一致！');
  } else {
    console.log(`  差值            : ${balanceDiff >= 0n ? '+' : ''}${balanceDiff}`);
    console.log(balanceDiff === 0n ? '  ✅ 全量餘額完全守恆' : '  ❌ 全量餘額不一致！');
  }
  console.log('==========================================');
}

// =============================================================================
// 主流程
// =============================================================================

(async () => {
  console.log('');
  console.log('==========================================');
  console.log('  混合請求壓測 (ab)');
  console.log('==========================================');
  console.log(`  connections  : ${CONNECTIONS} (general: ${GENERAL_CONC}, transfer: ${TRANSFER_TOTAL_CONC})`);
  console.log(`  duration     : ${DURATION}s`);
  console.log(`  account IDs  : ${MIN_ID} – ${MAX_ID}`);
  console.log(`  general url  : ${GENERAL_URL}`);
  console.log(`  transfer url : ${TRANSFER_URL}`);
  console.log(`  transfer 多樣化: ${TRANSFER_PAIRS} 組帳號對，各 concurrency=${TRANSFER_PAIR_CONC}`);
  console.log('==========================================');
  console.log('');

  // 產生多組 fromId/toId
  const transferPairs = buildTransferPairs(TRANSFER_PAIRS);

  // 為每個 pair 建立暫存 body 檔
  const postFiles = transferPairs.map((pair, i) => {
    const filePath = path.join(os.tmpdir(), `ab_transfer_${Date.now()}_${i}.json`);
    fs.writeFileSync(filePath, JSON.stringify({ fromId: pair.fromId, toId: pair.toId, amount: AMOUNT }));
    return filePath;
  });

  // General 固定打一個帳號
  const generalAccountId = randAccountId();

  console.log('開始壓測...');

  // 同時跑 general(1個) + transfer(TRANSFER_PAIRS個) ab
  const allPromises = [
    runAb({
      label:       'General API',
      url:         `${GENERAL_URL}/accounts/${generalAccountId}`,
      method:      'GET',
      concurrency: GENERAL_CONC,
      timelimit:   DURATION,
    }),
    ...transferPairs.map((pair, i) =>
      runAb({
        label:       `Transfer-${i + 1} (${pair.fromId}→${pair.toId})`,
        url:         `${TRANSFER_URL}/transfers`,
        method:      'POST',
        postFile:    postFiles[i],
        contentType: 'application/json',
        concurrency: TRANSFER_PAIR_CONC,
        timelimit:   DURATION,
      })
    ),
  ];

  const [generalResult, ...transferResults] = await Promise.all(allPromises);

  // 清理暫存檔
  postFiles.forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });

  // 合併所有 transfer 結果
  const transferResult = mergeAbResults(transferResults);

  // --------------------------------------------------
  // 結果匯整
  // --------------------------------------------------
  const gTotal   = generalResult  ? generalResult.totalReqs     : 0;
  const tTotal   = transferResult ? transferResult.totalReqs    : 0;
  const gSuccess = generalResult  ? generalResult.successCount  : 0;
  const tSuccess = transferResult ? transferResult.successCount : 0;
  const gFail    = generalResult  ? generalResult.failCount     : 0;
  const tFail    = transferResult ? transferResult.failCount    : 0;
  const gRps     = generalResult  ? generalResult.rps           : 0;
  const tRps     = transferResult ? transferResult.rps          : 0;

  const totalReqs      = gTotal + tTotal;
  const totalSuccess   = gSuccess + tSuccess;
  const totalFail      = gFail + tFail;
  const overallSuccess = totalReqs > 0 ? ((totalSuccess / totalReqs) * 100).toFixed(2) : '0.00';
  const overallFail    = totalReqs > 0 ? ((totalFail    / totalReqs) * 100).toFixed(2) : '0.00';

  const gw = GENERAL_CONC / CONNECTIONS;
  const tw = TRANSFER_TOTAL_CONC / CONNECTIONS;
  const avgLatency = generalResult && transferResult
    ? (generalResult.meanLatency * gw + transferResult.meanLatency * tw).toFixed(2)
    : '0.00';
  const p95Latency = Math.max(generalResult?.p95 || 0, transferResult?.p95 || 0);
  const p99Latency = Math.max(generalResult?.p99 || 0, transferResult?.p99 || 0);

  console.log('');
  console.log('==========================================');
  console.log('  壓測結果');
  console.log('==========================================');
  console.log(`  總 RPS (avg)        : ${(gRps + tRps).toFixed(2)}`);
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
  console.log(`  RPS avg  : ${gRps}`);
  console.log(`  Latency  : avg=${generalResult?.meanLatency || 0}ms  p95=${generalResult?.p95 || 0}ms  p99=${generalResult?.p99 || 0}ms`);
  printAbStats(generalResult);

  console.log('');
  console.log('  --- Transfer API ---');
  console.log(`  RPS avg  : ${tRps.toFixed(2)}  (${TRANSFER_PAIRS} 個 ab process 合計)`);
  console.log(`  Latency  : avg=${transferResult?.meanLatency || 0}ms  p95=${transferResult?.p95 || 0}ms  p99=${transferResult?.p99 || 0}ms`);
  printAbStats(transferResult);
  console.log('==========================================');

  // --------------------------------------------------
  // 餘額一致性檢查：等所有 job 跑完後再查
  // --------------------------------------------------
  if (!SKIP_BALANCE_CHECK) {
    await waitForQueueDrain();
    await checkFullBalanceConsistency();
  }
})();
