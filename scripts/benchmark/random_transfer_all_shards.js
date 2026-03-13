'use strict';

const axios = require('axios');

const API = process.env.API || 'http://127.0.0.1:7001';
const CONCURRENCY = Number(process.env.CONCURRENCY || 200);
const DURATION_SECONDS = Number(process.env.DURATION_SECONDS || 10);
const MAX_ACCOUNT_ID = Number(process.env.MAX_ACCOUNT_ID || 1000);
const AMOUNT = Number(process.env.AMOUNT || 1);

const SHARD_COUNT = Number(process.env.SHARD_COUNT || 4);

const JOB_POLL_INTERVAL_MS = Number(process.env.JOB_POLL_INTERVAL_MS || 200);
const JOB_POLL_TIMEOUT_MS = Number(process.env.JOB_POLL_TIMEOUT_MS || 10000);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
  const response = await axios.post(`${API}/transfers`, {
    fromId,
    toId,
    amount,
  }, {
    timeout: 5000,
    validateStatus: () => true,
  });

  return response;
}

async function getTransferJob(jobId) {
  const response = await axios.get(`${API}/transfer-jobs/${jobId}`, {
    timeout: 5000,
    validateStatus: () => true,
  });

  return response;
}

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
    const createResp = await createTransferJob({
      fromId,
      toId,
      amount: AMOUNT,
    });

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
      stats.successRequests += 1;

      const transferResult = result.job.result || {};

      if (transferResult.type === 'same-shard') {
        stats.sameShardSuccess += 1;
      } else if (transferResult.type === 'cross-shard') {
        stats.crossShardSuccess += 1;
      } else {
        stats.unknownTypeSuccess += 1;
      }

    } else {
      stats.failedRequests += 1;

      const errorMessage = result.job.error && result.job.error.message;

      if (errorMessage === 'insufficient funds') {
        stats.insufficientFunds += 1;
      } else {
        stats.otherBusinessFailed += 1;
      }
    }

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
  console.log('Small Bank Random Transfer Benchmark');
  console.log('========================================');
  console.log('');

  console.log(`API=${API}`);
  console.log(`CONCURRENCY=${CONCURRENCY}`);
  console.log(`DURATION_SECONDS=${DURATION_SECONDS}`);
  console.log(`MAX_ACCOUNT_ID=${MAX_ACCOUNT_ID}`);
  console.log(`AMOUNT=${AMOUNT}`);
  console.log(`SHARD_COUNT=${SHARD_COUNT}`);
  console.log(`JOB_POLL_INTERVAL_MS=${JOB_POLL_INTERVAL_MS}`);
  console.log(`JOB_POLL_TIMEOUT_MS=${JOB_POLL_TIMEOUT_MS}`);
  console.log('');

  const stats = {
    totalRequests: 0,
    successRequests: 0,
    failedRequests: 0,

    sameShardPicked: 0,
    crossShardPicked: 0,

    sameShardSuccess: 0,
    crossShardSuccess: 0,
    unknownTypeSuccess: 0,

    insufficientFunds: 0,
    otherBusinessFailed: 0,
    enqueueFailed: 0,
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

  const sameShardPickedRate = (stats.sameShardPicked / stats.totalRequests) * 100;
  const crossShardPickedRate = (stats.crossShardPicked / stats.totalRequests) * 100;

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
  console.log(`Same-Shard Success  : ${stats.sameShardSuccess}`);
  console.log(`Cross-Shard Success : ${stats.crossShardSuccess}`);
  console.log(`Unknown Type Success: ${stats.unknownTypeSuccess}`);
  console.log('');

  console.log('Failure Breakdown');
  console.log('----------------------------------------');

  console.log(`Insufficient Funds  : ${stats.insufficientFunds}`);
  console.log(`Other Business Fail : ${stats.otherBusinessFailed}`);
  console.log(`Enqueue Failed      : ${stats.enqueueFailed}`);
  console.log(`Request Errors      : ${stats.requestErrors}`);

  console.log('');
  console.log('========================================');
  console.log('Benchmark Finished');
  console.log('========================================');
}

main().catch(err => {
  console.error('benchmark fatal error:', err);
  process.exit(1);
});
