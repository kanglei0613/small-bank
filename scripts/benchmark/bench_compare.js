#!/usr/bin/env node
/**
 * bench_compare.js — drainQueue Sequential vs Concurrent 對比壓測
 *
 * 測試方法：
 *   選 5 個固定的跨 shard 轉帳 pair，每個 pair 送 JOBS_PER_SENDER 筆 job。
 *   同一個 fromId 的 N 筆 job 會堆在同一個 per-fromId queue 裡，
 *   drainQueue 用 batchSize 個 job 一次跑，這裡才會出現 row-lock contention。
 *
 * Concurrent 模式（QUEUE_DRAIN_SEQUENTIAL=false）：
 *   batchSize 個 Saga 同時 UPDATE 同一個 fromAccount 列
 *   → PG row lock 只有 1 個拿到，其他 N-1 個 lock_timeout(200ms) 失敗
 *   → 成功率 ≈ 1/batchSize
 *
 * Sequential 模式（QUEUE_DRAIN_SEQUENTIAL=true，預設）：
 *   for...of 逐一執行，零 contention，100% 成功
 *   → 吞吐量受限於單條 Saga 延遲
 *
 * 最佳解：Sequential + 多台 queue-worker 水平擴展
 *
 * 執行：
 *   node scripts/benchmark/bench_compare.js
 */

'use strict';

const fs            = require('fs');
const http          = require('http');
const { execSync }  = require('child_process');

// =============================================================================
// 設定
// =============================================================================

const TRANSFER_URL    = 'http://127.0.0.1:7010';
const PG_USER         = process.env.PG_USER || 'kanglei0613';
const JOBS_PER_SENDER = 40;   // 每個 fromId 送多少筆 job（製造 queue 積壓）
const DRAIN_TIMEOUT_S = 120;  // 最多等幾秒 queue 清空

// 5 個固定的跨 shard pair（確保在 seed 1-50000 範圍內）
// fromId % 4 → shard,  toId % 4 → 不同 shard
const SENDERS = [
  { from: 100, to: 101 }, // s0 → s1
  { from: 201, to: 202 }, // s1 → s2
  { from: 302, to: 303 }, // s2 → s3
  { from: 403, to: 400 }, // s3 → s0
  { from: 500, to: 501 }, // s0 → s1
];

// 驗證所有 pair 都是跨 shard
for (const s of SENDERS) {
  if (s.from % 4 === s.to % 4) throw new Error(`Pair ${s.from}→${s.to} is same-shard, fix SENDERS`);
}

// =============================================================================
// 工具
// =============================================================================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpPost(url, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', () => resolve({ status: 0 }));
    req.write(data);
    req.end();
  });
}

/** 設定 queue-worker 的 drain 模式並重啟 */
async function setWorkerMode(sequential) {
  const mode = sequential ? 'true' : 'false';
  const label = sequential ? 'SEQUENTIAL ✓' : 'CONCURRENT (buggy)';
  console.log(`\n  ⟳ 切換 queue-worker → ${label}`);

  // 用 docker-compose.override.yml 注入環境變數（最可靠的方式）
  const override = `services:\n  queue-worker:\n    environment:\n      QUEUE_DRAIN_SEQUENTIAL: "${mode}"\n`;
  fs.writeFileSync('docker-compose.override.yml', override);

  try {
    execSync('docker compose up -d --no-deps queue-worker', { stdio: 'ignore' });
  } catch (e) {
    console.warn('  ⚠ compose up 失敗，嘗試 restart:', e.message);
    execSync('docker compose restart queue-worker', { stdio: 'ignore' });
  }

  await sleep(3000); // 等 worker 完全啟動
  console.log(`  queue-worker 已就緒（QUEUE_DRAIN_SEQUENTIAL=${mode}）`);
}

/** 清除所有 shard 的跨 shard 轉帳紀錄，回傳刪除筆數 */
function deleteAsyncTransfers() {
  let total = 0;
  for (let s = 0; s < 4; s++) {
    try {
      const out = execSync(
        `docker exec small-bank-postgres-s${s}-1 psql -U ${PG_USER} -d small_bank_s${s} -t -c ` +
        `"DELETE FROM transfers WHERE (from_account_id % 4) != (to_account_id % 4) RETURNING id;"`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
      ).trim();
      const lines = out.split('\n').filter(l => l.trim() && l.trim() !== '');
      total += lines.length;
    } catch { /* 忽略 */ }
  }
  return total;
}

/** 清除 Redis queue 殘留 */
function flushRedisQueues() {
  try {
    execSync('docker exec small-bank-redis-1 redis-cli KEYS "transfer:queue:*" | xargs -r docker exec -i small-bank-redis-1 redis-cli DEL', { stdio: 'ignore', shell: true });
  } catch { /* 忽略 */ }
  // 備用：直接 FLUSHDB（只清 db0）
  try { execSync('docker exec small-bank-redis-1 redis-cli FLUSHDB', { stdio: 'ignore' }); } catch { /* 忽略 */ }
}

/** 查詢特定 fromId 在 DB 的 COMPLETED 轉帳數 */
function countCompleted(fromId) {
  const shardId = fromId % 4;
  try {
    const out = execSync(
      `docker exec small-bank-postgres-s${shardId}-1 psql -U ${PG_USER} -d small_bank_s${shardId} -t -c ` +
      `"SELECT COUNT(*) FROM transfers WHERE from_account_id = ${fromId} AND status = 'COMPLETED';"`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
    ).trim();
    return parseInt(out) || 0;
  } catch { return -1; }
}

/** 查詢特定 fromId 在 DB 的 FAILED 轉帳數 */
function countFailed(fromId) {
  const shardId = fromId % 4;
  try {
    const out = execSync(
      `docker exec small-bank-postgres-s${shardId}-1 psql -U ${PG_USER} -d small_bank_s${shardId} -t -c ` +
      `"SELECT COUNT(*) FROM transfers WHERE from_account_id = ${fromId} AND status = 'FAILED';"`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
    ).trim();
    return parseInt(out) || 0;
  } catch { return -1; }
}

/** 等待 Redis queue 完全清空 */
async function waitQueueDrain(label) {
  process.stdout.write(`\n  等待 drain 完成`);
  const start = Date.now();
  let zeroCount = 0;

  for (let i = 0; i < DRAIN_TIMEOUT_S / 2; i++) {
    await sleep(2000);
    let count = 0;
    try {
      const out = execSync(
        `docker exec small-bank-redis-1 redis-cli KEYS "transfer:queue:from:*"`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
      ).trim();
      count = out ? out.split('\n').filter(Boolean).length : 0;
    } catch { /* 忽略 */ }

    process.stdout.write(count > 0 ? ` [${count}]` : ' .');
    if (count === 0) {
      zeroCount++;
      if (zeroCount >= 2) break; // 連續2次確認
    } else {
      zeroCount = 0;
    }
  }

  const elapsed = Math.round((Date.now() - start) / 1000);
  console.log(` 完成（${elapsed}s）`);
  return elapsed;
}

// =============================================================================
// 單輪壓測
// =============================================================================

async function runRound(label, sequential) {
  console.log(`\n${'═'.repeat(62)}`);
  console.log(`  模式：${label}`);
  console.log(`  Senders: ${SENDERS.length}，每個 sender 送 ${JOBS_PER_SENDER} 筆 job`);
  console.log(`  總 job 數：${SENDERS.length * JOBS_PER_SENDER}`);
  console.log('═'.repeat(62));

  // 1. 清除 DB 跨 shard 紀錄
  const deleted = deleteAsyncTransfers();
  console.log(`  ✓ 清除 DB async 紀錄：${deleted} 筆`);

  // 2. 清除 Redis
  flushRedisQueues();
  console.log(`  ✓ 清除 Redis queue`);

  // 3. 切換 worker 模式
  await setWorkerMode(sequential);

  // 4. 並發送出全部 job
  console.log(`\n  發送 ${SENDERS.length * JOBS_PER_SENDER} 筆 async 轉帳...`);
  let enqueued = 0, rejected = 0;
  await Promise.all(
    SENDERS.flatMap(s =>
      Array.from({ length: JOBS_PER_SENDER }, () =>
        httpPost(`${TRANSFER_URL}/transfers`, { fromId: s.from, toId: s.to, amount: 1 })
          .then(r => r.status < 400 ? enqueued++ : rejected++)
      )
    )
  );
  console.log(`  入隊：${enqueued} 成功，${rejected} 拒絕`);

  // 5. 等 queue 清空
  const drainSec = await waitQueueDrain(label);

  // 6. 統計每個 sender 的結果
  console.log('\n  ┌─────────────────────────────────────────────────────┐');
  console.log(`  │  ${'fromId'.padEnd(8)} ${'toId'.padEnd(8)} ${'shard'.padStart(8)} ${'COMPLETED'.padStart(12)} ${'FAILED'.padStart(8)}  │`);
  console.log('  ├─────────────────────────────────────────────────────┤');

  let totalCompleted = 0, totalFailed = 0;
  for (const s of SENDERS) {
    const completed = countCompleted(s.from);
    const failed    = countFailed(s.from);
    totalCompleted += completed;
    totalFailed    += failed;
    const shardStr = `s${s.from % 4}→s${s.to % 4}`;
    console.log(`  │  ${String(s.from).padEnd(8)} ${String(s.to).padEnd(8)} ${shardStr.padStart(8)} ${String(completed).padStart(12)} ${String(failed).padStart(8)}  │`);
  }

  console.log('  ├─────────────────────────────────────────────────────┤');
  console.log(`  │  ${'合計'.padEnd(8)} ${''.padEnd(8)} ${''.padStart(8)} ${String(totalCompleted).padStart(12)} ${String(totalFailed).padStart(8)}  │`);
  console.log('  └─────────────────────────────────────────────────────┘');

  const successRate = enqueued > 0 ? (totalCompleted / enqueued * 100).toFixed(1) : '0.0';
  console.log(`\n  成功率：${totalCompleted}/${enqueued} = ${successRate}%`);
  console.log(`  drain 耗時：${drainSec}s`);

  return { label, sequential, enqueued, totalCompleted, totalFailed, drainSec, successRate };
}

// =============================================================================
// 主流程
// =============================================================================

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║   drainQueue Concurrent vs Sequential — 對比壓測             ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  問題：同一 fromId 的 N 個 Saga 並發跑時，全部競爭同一      ║');
  console.log('║        PG row lock → N-1 個 lock_timeout(200ms) 失敗        ║');
  console.log('║  修正：改為 sequential，逐一執行，零 contention              ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  const results = [];

  // Round 1: Concurrent
  results.push(await runRound('Concurrent（Promise.all，batchSize 個同時跑）', false));

  await sleep(1000);

  // Round 2: Sequential
  results.push(await runRound('Sequential（for...of，逐一執行）', true));

  // 還原：清掉 override，重啟為預設 sequential 模式
  console.log('\n  ⟳ 還原 queue-worker 為預設 sequential 模式...');
  try { fs.unlinkSync('docker-compose.override.yml'); } catch { /* 忽略 */ }
  try { execSync('docker compose up -d --no-deps queue-worker', { stdio: 'ignore' }); } catch { /* 忽略 */ }

  // 對比報告
  const [c, s] = results;
  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║                       對比結果                               ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  ${'指標'.padEnd(22)} ${'Concurrent'.padStart(16)} ${'Sequential'.padStart(16)} ║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');

  const rows = [
    ['入隊成功筆數',    c.enqueued,        s.enqueued],
    ['COMPLETED 筆數', c.totalCompleted,  s.totalCompleted],
    ['FAILED 筆數',    c.totalFailed,     s.totalFailed],
    ['成功率',          c.successRate+'%', s.successRate+'%'],
    ['drain 耗時(s)',  c.drainSec,        s.drainSec],
  ];

  for (const [lbl, cv, sv] of rows) {
    console.log(`║  ${lbl.padEnd(22)} ${String(cv).padStart(16)} ${String(sv).padStart(16)} ║`);
  }

  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  Tradeoff：                                                   ║');
  console.log('║  Concurrent：drain 快（job 馬上 fail，queue 馬上清空）       ║');
  console.log('║    但 N-1 個 Saga 因 lock_timeout 失敗 → 成功率 ≈ 1/N       ║');
  console.log('║  Sequential：drain 慢（逐一執行），但 100% 成功率             ║');
  console.log('║  最佳解：Sequential + 多台 worker 水平擴展（各守自己的       ║');
  console.log('║    fromId range，不同 fromId 之間天然並行，零 contention）   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
}

main().catch(err => { console.error(err); process.exit(1); });
