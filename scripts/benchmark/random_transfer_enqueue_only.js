'use strict';

const http = require('http');
const https = require('https');
const axios = require('axios');

const API = process.env.API || 'http://127.0.0.1:7001';
const CONCURRENCY = Number(process.env.CONCURRENCY || 300);
const DURATION_SECONDS = Number(process.env.DURATION_SECONDS || 30);
const MAX_ACCOUNT_ID = Number(process.env.MAX_ACCOUNT_ID || 1000);
const AMOUNT = Number(process.env.AMOUNT || 1);
const SHARD_COUNT = Number(process.env.SHARD_COUNT || 4);

// 建立 keep-alive agent
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: Math.max(CONCURRENCY * 4, 256),
  maxFreeSockets: 128,
  keepAliveMsecs: 1000,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: Math.max(CONCURRENCY * 4, 256),
  maxFreeSockets: 128,
  keepAliveMsecs: 1000,
});

// 共用 axios client
const client = axios.create({
  timeout: 5000,
  validateStatus: () => true,
  httpAgent,
  httpsAgent,
});

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandomAccountPair(maxAccountId) {
  const fromId = randomInt(1, maxAccountId);
  let toId = randomInt(1, maxAccountId);

  while (toId === fromId) {
    toId = randomInt(1, maxAccountId);
  }

  return { fromId, toId };
}

function calcShardId(accountId) {
  return Number(accountId) % SHARD_COUNT;
}

async function createTransferJob({ fromId, toId, amount }) {
  const response = await client.post(`${API}/transfers`, {
    fromId,
    toId,
    amount,
  });

  return response;
}

async function runOneTransfer(stats) {
  const { fromId, toId } = pickRandomAccountPair(MAX_ACCOUNT_ID);

  const fromShardId = calcShardId(fromId);
  const toShardId = calcShardId(toId);
  const isSameShard = fromShardId === toShardId;

  stats.totalRequests += 1;

  if (isSameShard) {
    stats.sameShardPicked += 1;
  } else {
    stats.crossShardPicked += 1;
  }

  try {
    const response = await createTransferJob({
      fromId,
      toId,
      amount: AMOUNT,
    });

    if (response.status === 202 && response.data && response.data.ok) {
      stats.successRequests += 1;

      const data = response.data.data || {};

      if (data.jobId) {
        stats.jobCreated += 1;
      } else {
        stats.missingJobId += 1;
      }

      return;
    }

    stats.failedRequests += 1;

    if (response.status === 429) {
      stats.http429 += 1;
      return;
    }

    if (response.status >= 500) {
      stats.http5xx += 1;
      return;
    }

    if (response.status >= 400) {
      stats.http4xx += 1;
      return;
    }

    stats.otherHttpStatus += 1;
  } catch (err) {
    stats.failedRequests += 1;
    stats.requestErrors += 1;
  }
}

async function worker(deadline, stats) {
  while (Date.now() < deadline) {
    await runOneTransfer(stats);
  }
}

async function main() {
  console.log('========================================');
  console.log('Small Bank Random Transfer Enqueue-Only Benchmark');
  console.log('========================================');
  console.log('');

  console.log(`API=${API}`);
  console.log(`CONCURRENCY=${CONCURRENCY}`);
  console.log(`DURATION_SECONDS=${DURATION_SECONDS}`);
  console.log(`MAX_ACCOUNT_ID=${MAX_ACCOUNT_ID}`);
  console.log(`AMOUNT=${AMOUNT}`);
  console.log(`SHARD_COUNT=${SHARD_COUNT}`);
  console.log('KEEP_ALIVE=true');
  console.log('');

  const stats = {
    totalRequests: 0,
    successRequests: 0,
    failedRequests: 0,

    sameShardPicked: 0,
    crossShardPicked: 0,

    jobCreated: 0,
    missingJobId: 0,

    http429: 0,
    http4xx: 0,
    http5xx: 0,
    otherHttpStatus: 0,
    requestErrors: 0,
  };

  const startedAt = Date.now();
  const deadline = startedAt + DURATION_SECONDS * 1000;

  await Promise.all(
    Array.from({ length: CONCURRENCY }, () => worker(deadline, stats))
  );

  const endedAt = Date.now();
  const elapsedSeconds = (endedAt - startedAt) / 1000;

  const successRate = stats.totalRequests === 0
    ? 0
    : (stats.successRequests / stats.totalRequests) * 100;

  const avgTotalRps = stats.totalRequests / elapsedSeconds;
  const avgSuccessRps = stats.successRequests / elapsedSeconds;

  const sameShardPickedRate = stats.totalRequests === 0
    ? 0
    : (stats.sameShardPicked / stats.totalRequests) * 100;

  const crossShardPickedRate = stats.totalRequests === 0
    ? 0
    : (stats.crossShardPicked / stats.totalRequests) * 100;

  console.log('========================================');
  console.log('Benchmark Result');
  console.log('========================================');
  console.log('');

  console.log(`Elapsed Seconds     : ${elapsedSeconds.toFixed(2)}`);
  console.log(`Total Requests      : ${stats.totalRequests}`);
  console.log(`Success Requests    : ${stats.successRequests}`);
  console.log(`Failed Requests     : ${stats.failedRequests}`);
  console.log(`Success Rate        : ${successRate.toFixed(2)}%`);
  console.log(`Avg Total RPS       : ${avgTotalRps.toFixed(2)}`);
  console.log(`Avg Success RPS     : ${avgSuccessRps.toFixed(2)}`);
  console.log('');

  console.log('Shard Mix');
  console.log('----------------------------------------');
  console.log(`Same-Shard Picked   : ${stats.sameShardPicked} (${sameShardPickedRate.toFixed(2)}%)`);
  console.log(`Cross-Shard Picked  : ${stats.crossShardPicked} (${crossShardPickedRate.toFixed(2)}%)`);
  console.log('');

  console.log('Success Breakdown');
  console.log('----------------------------------------');
  console.log(`Job Created         : ${stats.jobCreated}`);
  console.log(`Missing Job ID      : ${stats.missingJobId}`);
  console.log('');

  console.log('Failure Breakdown');
  console.log('----------------------------------------');
  console.log(`HTTP 429            : ${stats.http429}`);
  console.log(`HTTP 4xx            : ${stats.http4xx}`);
  console.log(`HTTP 5xx            : ${stats.http5xx}`);
  console.log(`Other HTTP Status   : ${stats.otherHttpStatus}`);
  console.log(`Request Errors      : ${stats.requestErrors}`);
  console.log('');

  console.log('========================================');
  console.log('Benchmark Finished');
  console.log('========================================');

  httpAgent.destroy();
  httpsAgent.destroy();
}

main().catch(err => {
  console.error('benchmark fatal error:', err);

  httpAgent.destroy();
  httpsAgent.destroy();

  process.exit(1);
});
