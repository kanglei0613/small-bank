'use strict';

/*
random_transfer_same_shard.js

用途：
隨機產生 same-shard 的 fromId / toId，持續對 /transfers 發送請求，
用來測試 sharding 架構下 same-shard transfer 的吞吐量。

使用方式：
node scripts/random_transfer_same_shard.js

可調整參數：
MAX_ACCOUNT_ID   可用帳戶上限
CONCURRENCY      每批同時送出的請求數
DURATION_SECONDS 測試秒數
*/

const axios = require('axios');
const http = require('http');

const API_URL = 'http://127.0.0.1:7001/transfers';

// 可用帳戶範圍，例如 1 ~ 1000
const MAX_ACCOUNT_ID = 1000;

// 每批同時送出的 request 數量
const CONCURRENCY = 250;

// 測試總時長（秒）
const DURATION_SECONDS = 30;

// 固定轉帳金額
const AMOUNT = 1;

// HTTP keep-alive agent
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 1000,
});

// axios instance
const client = axios.create({
  httpAgent,
  timeout: 5000,
});

// 成功與失敗計數
let successCount = 0;
let failCount = 0;
let totalCount = 0;

// 失敗狀態統計
const failStatusMap = {};

// 隨機產生帳戶 id
function randomAccountId() {
  return Math.floor(Math.random() * MAX_ACCOUNT_ID) + 1;
}

// 計算 shardId
function getShardId(accountId) {
  return accountId % 2;
}

// 產生一筆 same-shard 的隨機轉帳資料
function buildSameShardTransferPayload() {
  const fromId = randomAccountId();
  const fromShardId = getShardId(fromId);

  let toId = randomAccountId();

  while (toId === fromId || getShardId(toId) !== fromShardId) {
    toId = randomAccountId();
  }

  return {
    fromId,
    toId,
    amount: AMOUNT,
  };
}

// 執行一筆 same-shard 隨機轉帳請求
async function sendSameShardTransfer() {
  const payload = buildSameShardTransferPayload();

  try {
    await client.post(API_URL, payload);
    successCount += 1;
  } catch (err) {
    failCount += 1;

    const status = err.response?.status || 'NETWORK_ERROR';
    failStatusMap[status] = (failStatusMap[status] || 0) + 1;
  } finally {
    totalCount += 1;
  }
}

// 主測試流程
async function main() {
  console.log('========================================');
  console.log('Small Bank Same-Shard Random Benchmark');
  console.log('========================================');
  console.log(`API_URL: ${API_URL}`);
  console.log(`MAX_ACCOUNT_ID: ${MAX_ACCOUNT_ID}`);
  console.log(`CONCURRENCY: ${CONCURRENCY}`);
  console.log(`DURATION_SECONDS: ${DURATION_SECONDS}`);
  console.log(`AMOUNT: ${AMOUNT}`);
  console.log('');

  const startTime = Date.now();
  const endTime = startTime + DURATION_SECONDS * 1000;

  while (Date.now() < endTime) {
    const batch = [];

    for (let i = 0; i < CONCURRENCY; i++) {
      batch.push(sendSameShardTransfer());
    }

    await Promise.all(batch);

    const elapsedSeconds = (Date.now() - startTime) / 1000;
    const currentRps = elapsedSeconds === 0
      ? 0
      : Math.floor(totalCount / elapsedSeconds);

    console.log(
      `[Progress] total=${totalCount}, success=${successCount}, fail=${failCount}, avg_rps=${currentRps}`
    );
  }

  const totalSeconds = (Date.now() - startTime) / 1000;
  const avgRps = totalSeconds === 0 ? 0 : Math.floor(totalCount / totalSeconds);
  const successRps = totalSeconds === 0 ? 0 : Math.floor(successCount / totalSeconds);
  const failRps = totalSeconds === 0 ? 0 : Math.floor(failCount / totalSeconds);
  const successRate = totalCount === 0
    ? '0.00'
    : ((successCount / totalCount) * 100).toFixed(2);

  console.log('');
  console.log('========================================');
  console.log('Same-Shard Random Benchmark Finished');
  console.log('========================================');
  console.log(`Total Requests: ${totalCount}`);
  console.log(`Success Requests: ${successCount}`);
  console.log(`Failed Requests: ${failCount}`);
  console.log(`Success Rate: ${successRate}%`);
  console.log(`Avg Total RPS: ${avgRps}`);
  console.log(`Avg Success RPS: ${successRps}`);
  console.log(`Avg Fail RPS: ${failRps}`);
  console.log('Fail Status Breakdown:', failStatusMap);
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
