'use strict';

/*
random_transfer_same_shard.js

用途：
隨機產生 same-shard 的 fromId / toId，持續對 /transfers 發送請求，
並輪詢 transfer job 狀態，統計真正完成的 same-shard transfer 吞吐量。

使用方式：
node scripts/benchmark/random_transfer_same_shard.js

可調整參數：
API                 API base URL
MAX_ACCOUNT_ID      可用帳戶上限
CONCURRENCY         同時執行的 worker 數
DURATION_SECONDS    測試秒數
AMOUNT              固定轉帳金額
SHARD_COUNT         shard 數量
JOB_POLL_INTERVAL_MS  job 輪詢間隔
JOB_POLL_TIMEOUT_MS   job 輪詢 timeout
*/

const axios = require('axios');
const http = require('http');

const API = process.env.API || 'http://127.0.0.1:7001';
const API_URL = `${API}/transfers`;

const MAX_ACCOUNT_ID = Number(process.env.MAX_ACCOUNT_ID || 1000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 200);
const DURATION_SECONDS = Number(process.env.DURATION_SECONDS || 30);
const AMOUNT = Number(process.env.AMOUNT || 1);

const SHARD_COUNT = Number(process.env.SHARD_COUNT || 4);

const JOB_POLL_INTERVAL_MS = Number(process.env.JOB_POLL_INTERVAL_MS || 50);
const JOB_POLL_TIMEOUT_MS = Number(process.env.JOB_POLL_TIMEOUT_MS || 10000);

// HTTP keep-alive agent
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 1000,
});

// axios instance
const client = axios.create({
  httpAgent,
  timeout: 5000,
  validateStatus: () => true,
});

// 統計資料
const stats = {
  totalRequests: 0,
  successRequests: 0,
  failedRequests: 0,

  enqueueFailed: 0,
  requestErrors: 0,
  insufficientFunds: 0,
  otherBusinessFailed: 0,
  unexpectedTypeSuccess: 0,
};

// 睡眠
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 隨機產生帳戶 id
function randomAccountId() {
  return Math.floor(Math.random() * MAX_ACCOUNT_ID) + 1;
}

// 計算 shardId
function getShardId(accountId) {
  return accountId % SHARD_COUNT;
}

// 產生 same-shard payload
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

// 查 job
async function getTransferJob(jobId) {
  const response = await client.get(`${API}/transfer-jobs/${jobId}`);
  return response;
}

// 等待 job 完成
async function waitForJobResult(jobId) {
  const startedAt = Date.now();

  for (;;) {
    const elapsed = Date.now() - startedAt;

    if (elapsed > JOB_POLL_TIMEOUT_MS) {
      const err = new Error(`job polling timeout: ${jobId}`);
      err.status = 504;
      throw err;
    }

    const response = await getTransferJob(jobId);

    if (response.status !== 200 || !response.data || !response.data.ok) {
      const err = new Error(`job query failed: status=${response.status}`);
      err.status = response.status || 500;
      throw err;
    }

    const job = response.data.data;

    if (!job) {
      const err = new Error(`job not found: ${jobId}`);
      err.status = 404;
      throw err;
    }

    if (job.status === 'queued' || job.status === 'processing') {
      await sleep(JOB_POLL_INTERVAL_MS);
      continue;
    }

    if (job.status === 'success') {
      return {
        ok: true,
        job,
      };
    }

    if (job.status === 'failed') {
      return {
        ok: false,
        job,
      };
    }

    const err = new Error(`unknown job status: ${job.status}`);
    err.status = 500;
    throw err;
  }
}

// 執行一筆 transfer
async function sendSameShardTransfer() {
  const payload = buildSameShardTransferPayload();

  stats.totalRequests += 1;

  try {
    const createResp = await client.post(API_URL, payload);

    if (createResp.status !== 202 || !createResp.data || !createResp.data.ok) {
      stats.failedRequests += 1;
      stats.enqueueFailed += 1;
      return;
    }

    const jobId = createResp.data.data && createResp.data.data.jobId;

    if (!jobId) {
      stats.failedRequests += 1;
      stats.enqueueFailed += 1;
      return;
    }

    const result = await waitForJobResult(jobId);

    if (result.ok) {
      const transferResult = result.job.result || {};

      if (transferResult.type !== 'same-shard') {
        stats.failedRequests += 1;
        stats.unexpectedTypeSuccess += 1;
        return;
      }

      stats.successRequests += 1;
      return;
    }

    stats.failedRequests += 1;

    const errorMessage = result.job.error && result.job.error.message;

    if (errorMessage === 'insufficient funds') {
      stats.insufficientFunds += 1;
    } else {
      stats.otherBusinessFailed += 1;
    }

  } catch (err) {
    stats.failedRequests += 1;
    stats.requestErrors += 1;
  }
}

// worker
async function worker(deadline) {
  while (Date.now() < deadline) {
    await sendSameShardTransfer();
  }
}

// 主流程
async function main() {

  console.log('========================================');
  console.log('Small Bank Same-Shard Random Benchmark');
  console.log('========================================');

  console.log(`API: ${API}`);
  console.log(`API_URL: ${API_URL}`);
  console.log(`MAX_ACCOUNT_ID: ${MAX_ACCOUNT_ID}`);
  console.log(`CONCURRENCY: ${CONCURRENCY}`);
  console.log(`DURATION_SECONDS: ${DURATION_SECONDS}`);
  console.log(`AMOUNT: ${AMOUNT}`);
  console.log(`SHARD_COUNT: ${SHARD_COUNT}`);
  console.log(`JOB_POLL_INTERVAL_MS: ${JOB_POLL_INTERVAL_MS}`);
  console.log(`JOB_POLL_TIMEOUT_MS: ${JOB_POLL_TIMEOUT_MS}`);
  console.log('');

  const startedAt = Date.now();
  const deadline = startedAt + DURATION_SECONDS * 1000;

  await Promise.all(
    Array.from({ length: CONCURRENCY }, () => worker(deadline))
  );

  const elapsedSeconds = (Date.now() - startedAt) / 1000;

  const successRate = stats.totalRequests === 0
    ? 0
    : (stats.successRequests / stats.totalRequests) * 100;

  const avgTotalRps = stats.totalRequests / elapsedSeconds;
  const avgSuccessRps = stats.successRequests / elapsedSeconds;
  const avgFailRps = stats.failedRequests / elapsedSeconds;

  console.log('');
  console.log('========================================');
  console.log('Same-Shard Random Benchmark Finished');
  console.log('========================================');

  console.log(`Elapsed Seconds     : ${elapsedSeconds.toFixed(2)}`);
  console.log(`Total Requests      : ${stats.totalRequests}`);
  console.log(`Success Requests    : ${stats.successRequests}`);
  console.log(`Failed Requests     : ${stats.failedRequests}`);
  console.log(`Success Rate        : ${successRate.toFixed(2)}%`);
  console.log(`Avg Total RPS       : ${avgTotalRps.toFixed(2)}`);
  console.log(`Avg Success RPS     : ${avgSuccessRps.toFixed(2)}`);
  console.log(`Avg Fail RPS        : ${avgFailRps.toFixed(2)}`);

  console.log('');
  console.log('Failure Breakdown');
  console.log('----------------------------------------');

  console.log(`Insufficient Funds  : ${stats.insufficientFunds}`);
  console.log(`Other Business Fail : ${stats.otherBusinessFailed}`);
  console.log(`Enqueue Failed      : ${stats.enqueueFailed}`);
  console.log(`Request Errors      : ${stats.requestErrors}`);
  console.log(`Unexpected Type     : ${stats.unexpectedTypeSuccess}`);

}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
