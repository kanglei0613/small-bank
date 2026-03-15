'use strict';

const http = require('http');
const https = require('https');
const axios = require('axios');

const API = process.env.API || 'http://127.0.0.1:7001';
const CONCURRENCY = Number(process.env.CONCURRENCY || 300);
const DURATION_SECONDS = Number(process.env.DURATION_SECONDS || 30);
const MAX_ACCOUNT_ID = Number(process.env.MAX_ACCOUNT_ID || 10000);
const INITIAL_USER_COUNT = Number(process.env.INITIAL_USER_COUNT || 10000);
const AMOUNT = Number(process.env.AMOUNT || 1);

// endpoint 權重
const WEIGHT_GET_ACCOUNT = Number(process.env.WEIGHT_GET_ACCOUNT || 35);
const WEIGHT_POST_TRANSFER = Number(process.env.WEIGHT_POST_TRANSFER || 25);
const WEIGHT_GET_TRANSFER_JOB = Number(process.env.WEIGHT_GET_TRANSFER_JOB || 15);
const WEIGHT_GET_TRANSFER_HISTORY = Number(process.env.WEIGHT_GET_TRANSFER_HISTORY || 15);
const WEIGHT_POST_USER = Number(process.env.WEIGHT_POST_USER || 5);
const WEIGHT_POST_ACCOUNT = Number(process.env.WEIGHT_POST_ACCOUNT || 5);

// keep-alive
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

const client = axios.create({
  timeout: 5000,
  validateStatus: () => true,
  httpAgent,
  httpsAgent,
});

// 簡單 state
const state = {
  nextUserId: INITIAL_USER_COUNT + 1,
  nextCreatedUserNameIndex: 1,
  createdUserIds: [],
  recentJobIds: [],
  maxRecentJobIds: 5000,
};

// eslint-disable-next-line no-unused-vars
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickRandomAccountId() {
  return randomInt(1, MAX_ACCOUNT_ID);
}

function pickRandomAccountPair() {
  const fromId = pickRandomAccountId();
  let toId = pickRandomAccountId();

  while (toId === fromId) {
    toId = pickRandomAccountId();
  }

  return { fromId, toId };
}

function pushRecentJobId(jobId) {
  if (!jobId) return;

  state.recentJobIds.push(jobId);

  if (state.recentJobIds.length > state.maxRecentJobIds) {
    state.recentJobIds.shift();
  }
}

function pickRecentJobId() {
  if (state.recentJobIds.length === 0) {
    return null;
  }

  const idx = randomInt(0, state.recentJobIds.length - 1);
  return state.recentJobIds[idx];
}

function pickWeightedAction() {
  const items = [
    { name: 'GET_ACCOUNT', weight: WEIGHT_GET_ACCOUNT },
    { name: 'POST_TRANSFER', weight: WEIGHT_POST_TRANSFER },
    { name: 'GET_TRANSFER_JOB', weight: WEIGHT_GET_TRANSFER_JOB },
    { name: 'GET_TRANSFER_HISTORY', weight: WEIGHT_GET_TRANSFER_HISTORY },
    { name: 'POST_USER', weight: WEIGHT_POST_USER },
    { name: 'POST_ACCOUNT', weight: WEIGHT_POST_ACCOUNT },
  ];

  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  const r = Math.random() * totalWeight;

  let acc = 0;
  for (const item of items) {
    acc += item.weight;
    if (r < acc) {
      return item.name;
    }
  }

  return 'GET_ACCOUNT';
}

function ensureEndpointStats(stats, name) {
  if (!stats.endpoints[name]) {
    stats.endpoints[name] = {
      total: 0,
      success: 0,
      failed: 0,
    };
  }

  return stats.endpoints[name];
}

function markEndpointResult(stats, endpointName, ok) {
  const endpoint = ensureEndpointStats(stats, endpointName);
  endpoint.total += 1;

  if (ok) {
    endpoint.success += 1;
  } else {
    endpoint.failed += 1;
  }
}

async function doGetAccount(stats) {
  const endpointName = 'GET /accounts/:id';
  stats.totalRequests += 1;

  const accountId = pickRandomAccountId();

  try {
    const response = await client.get(`${API}/accounts/${accountId}`);

    const ok = response.status === 200 && response.data && response.data.ok;
    if (ok) {
      stats.successRequests += 1;
    } else {
      stats.failedRequests += 1;
    }

    markEndpointResult(stats, endpointName, ok);
  } catch (err) {
    stats.failedRequests += 1;
    stats.requestErrors += 1;
    markEndpointResult(stats, endpointName, false);
  }
}

async function doPostTransfer(stats) {
  const endpointName = 'POST /transfers';
  stats.totalRequests += 1;

  const { fromId, toId } = pickRandomAccountPair();

  try {
    const response = await client.post(`${API}/transfers`, {
      fromId,
      toId,
      amount: AMOUNT,
    });

    const ok = response.status === 202 && response.data && response.data.ok;
    if (ok) {
      stats.successRequests += 1;
      stats.transferJobsCreated += 1;

      const jobId = response.data.data && response.data.data.jobId;
      if (jobId) {
        pushRecentJobId(jobId);
      }
    } else {
      stats.failedRequests += 1;
    }

    markEndpointResult(stats, endpointName, ok);
  } catch (err) {
    stats.failedRequests += 1;
    stats.requestErrors += 1;
    markEndpointResult(stats, endpointName, false);
  }
}

async function doGetTransferJob(stats) {
  const endpointName = 'GET /transfer-jobs/:jobId';
  stats.totalRequests += 1;

  const jobId = pickRecentJobId();

  if (!jobId) {
    // 沒有 jobId 可查，退而求其次打一個 account 查詢，避免浪費 worker
    return await doGetAccount(stats);
  }

  try {
    const response = await client.get(`${API}/transfer-jobs/${jobId}`);

    const ok = response.status === 200 && response.data && response.data.ok;
    if (ok) {
      stats.successRequests += 1;

      const job = response.data.data;
      if (job && job.status === 'success') {
        stats.jobPollSuccess += 1;
      } else if (job && job.status === 'failed') {
        stats.jobPollFailed += 1;
      } else {
        stats.jobPollQueued += 1;
      }
    } else {
      stats.failedRequests += 1;
    }

    markEndpointResult(stats, endpointName, ok);
  } catch (err) {
    stats.failedRequests += 1;
    stats.requestErrors += 1;
    markEndpointResult(stats, endpointName, false);
  }
}

async function doGetTransferHistory(stats) {
  const endpointName = 'GET /transfers?accountId=';
  stats.totalRequests += 1;

  const accountId = pickRandomAccountId();

  try {
    const response = await client.get(`${API}/transfers`, {
      params: {
        accountId,
        limit: 20,
      },
    });

    const ok = response.status === 200 && response.data && response.data.ok;
    if (ok) {
      stats.successRequests += 1;
    } else {
      stats.failedRequests += 1;
    }

    markEndpointResult(stats, endpointName, ok);
  } catch (err) {
    stats.failedRequests += 1;
    stats.requestErrors += 1;
    markEndpointResult(stats, endpointName, false);
  }
}

async function doPostUser(stats) {
  const endpointName = 'POST /users';
  stats.totalRequests += 1;

  const userName = `bench_user_${Date.now()}_${state.nextCreatedUserNameIndex++}`;

  try {
    const response = await client.post(`${API}/users`, {
      name: userName,
    });

    const ok = response.status === 201 && response.data && response.data.ok;
    if (ok) {
      stats.successRequests += 1;
      stats.createdUsers += 1;

      const user = response.data.data;
      if (user && user.id) {
        state.createdUserIds.push(Number(user.id));
      } else {
        // 如果 response 沒 user id，就用遞增 fallback
        state.createdUserIds.push(state.nextUserId++);
      }
    } else {
      stats.failedRequests += 1;
    }

    markEndpointResult(stats, endpointName, ok);
  } catch (err) {
    stats.failedRequests += 1;
    stats.requestErrors += 1;
    markEndpointResult(stats, endpointName, false);
  }
}

async function doPostAccount(stats) {
  const endpointName = 'POST /accounts';
  stats.totalRequests += 1;

  let userId = null;

  if (state.createdUserIds.length > 0) {
    const idx = randomInt(0, state.createdUserIds.length - 1);
    userId = state.createdUserIds[idx];
  } else {
    // fallback：用初始化 user 範圍內的隨機 userId
    userId = randomInt(1, INITIAL_USER_COUNT);
  }

  try {
    const response = await client.post(`${API}/accounts`, {
      userId,
      initialBalance: 100000,
    });

    const ok = (response.status === 201 || response.status === 200) && response.data && response.data.ok;
    if (ok) {
      stats.successRequests += 1;
      stats.createdAccounts += 1;
    } else {
      stats.failedRequests += 1;
    }

    markEndpointResult(stats, endpointName, ok);
  } catch (err) {
    stats.failedRequests += 1;
    stats.requestErrors += 1;
    markEndpointResult(stats, endpointName, false);
  }
}

async function runOneRequest(stats) {
  const action = pickWeightedAction();

  switch (action) {
    case 'GET_ACCOUNT':
      return await doGetAccount(stats);
    case 'POST_TRANSFER':
      return await doPostTransfer(stats);
    case 'GET_TRANSFER_JOB':
      return await doGetTransferJob(stats);
    case 'GET_TRANSFER_HISTORY':
      return await doGetTransferHistory(stats);
    case 'POST_USER':
      return await doPostUser(stats);
    case 'POST_ACCOUNT':
      return await doPostAccount(stats);
    default:
      return await doGetAccount(stats);
  }
}

async function worker(deadline, stats) {
  while (Date.now() < deadline) {
    await runOneRequest(stats);
  }
}

async function main() {
  console.log('========================================');
  console.log('Small Bank Random Request Benchmark');
  console.log('========================================');
  console.log('');

  console.log(`API=${API}`);
  console.log(`CONCURRENCY=${CONCURRENCY}`);
  console.log(`DURATION_SECONDS=${DURATION_SECONDS}`);
  console.log(`MAX_ACCOUNT_ID=${MAX_ACCOUNT_ID}`);
  console.log(`INITIAL_USER_COUNT=${INITIAL_USER_COUNT}`);
  console.log(`AMOUNT=${AMOUNT}`);
  console.log('');
  console.log('Weights');
  console.log('----------------------------------------');
  console.log(`GET_ACCOUNT=${WEIGHT_GET_ACCOUNT}`);
  console.log(`POST_TRANSFER=${WEIGHT_POST_TRANSFER}`);
  console.log(`GET_TRANSFER_JOB=${WEIGHT_GET_TRANSFER_JOB}`);
  console.log(`GET_TRANSFER_HISTORY=${WEIGHT_GET_TRANSFER_HISTORY}`);
  console.log(`POST_USER=${WEIGHT_POST_USER}`);
  console.log(`POST_ACCOUNT=${WEIGHT_POST_ACCOUNT}`);
  console.log('');

  const stats = {
    totalRequests: 0,
    successRequests: 0,
    failedRequests: 0,
    requestErrors: 0,

    transferJobsCreated: 0,
    jobPollSuccess: 0,
    jobPollFailed: 0,
    jobPollQueued: 0,

    createdUsers: 0,
    createdAccounts: 0,

    endpoints: {},
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

  console.log('Endpoint Breakdown');
  console.log('----------------------------------------');

  const endpointNames = Object.keys(stats.endpoints).sort();
  for (const name of endpointNames) {
    const item = stats.endpoints[name];
    console.log(`${name}`);
    console.log(`  Total   : ${item.total}`);
    console.log(`  Success : ${item.success}`);
    console.log(`  Failed  : ${item.failed}`);
  }

  console.log('');
  console.log('Extra Stats');
  console.log('----------------------------------------');
  console.log(`Transfer Jobs Created : ${stats.transferJobsCreated}`);
  console.log(`Job Poll Success      : ${stats.jobPollSuccess}`);
  console.log(`Job Poll Failed       : ${stats.jobPollFailed}`);
  console.log(`Job Poll Queued       : ${stats.jobPollQueued}`);
  console.log(`Created Users         : ${stats.createdUsers}`);
  console.log(`Created Accounts      : ${stats.createdAccounts}`);
  console.log(`Request Errors        : ${stats.requestErrors}`);

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
