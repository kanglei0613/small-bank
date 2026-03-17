'use strict';

const { performance } = require('perf_hooks');

function getArg(name, defaultValue) {
  const prefix = `--${name}=`;
  const found = process.argv.find(arg => arg.startsWith(prefix));

  if (!found) {
    return defaultValue;
  }

  return found.slice(prefix.length);
}

function toPositiveInt(value, fallback) {
  const n = Number(value);

  if (Number.isInteger(n) && n > 0) {
    return n;
  }

  return fallback;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickWeighted(items) {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);

  let r = Math.random() * totalWeight;

  for (const item of items) {
    r -= item.weight;

    if (r <= 0) {
      return item.name;
    }
  }

  return items[items.length - 1].name;
}

function createStats() {
  return {
    startedAt: null,
    endedAt: null,
    totalRequests: 0,
    successRequests: 0,
    failedRequests: 0,
    requestErrors: 0,
    transferJobsCreated: 0,
    transferJobPollHits: 0,
    statusCodes: {},
    endpointStats: {
      getAccount: { total: 0, success: 0, failed: 0 },
      postTransfer: { total: 0, success: 0, failed: 0 },
      getTransferJob: { total: 0, success: 0, failed: 0 },
      getTransferHistory: { total: 0, success: 0, failed: 0 },
      postUser: { total: 0, success: 0, failed: 0 },
      postAccount: { total: 0, success: 0, failed: 0 },
    },
  };
}

function createJobPool(limit) {
  const pool = [];

  return {
    push(jobId) {
      if (!jobId) {
        return;
      }

      pool.push(jobId);

      if (pool.length > limit) {
        pool.shift();
      }
    },

    pick() {
      if (pool.length === 0) {
        return null;
      }

      return pool[randomInt(0, pool.length - 1)];
    },

    size() {
      return pool.length;
    },
  };
}

function buildTransferBody(minAccountId, maxAccountId, amount) {
  const fromId = randomInt(minAccountId, maxAccountId);

  let toId = randomInt(minAccountId, maxAccountId);

  while (toId === fromId) {
    toId = randomInt(minAccountId, maxAccountId);
  }

  return {
    fromId,
    toId,
    amount,
  };
}

function buildUserBody(seq) {
  return {
    name: `final-bench-user-${Date.now()}-${seq}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

function buildAccountBody(minUserId, maxUserId, initialBalance) {
  return {
    userId: randomInt(minUserId, maxUserId),
    initialBalance,
  };
}

function buildRequest(config, jobPool, userSeq) {
  const picked = pickWeighted([
    { name: 'getAccount', weight: 35 },
    { name: 'postTransfer', weight: 25 },
    { name: 'getTransferJob', weight: 15 },
    { name: 'getTransferHistory', weight: 15 },
    { name: 'postUser', weight: 5 },
    { name: 'postAccount', weight: 5 },
  ]);

  if (picked === 'getAccount') {
    const accountId = randomInt(config.minAccountId, config.maxAccountId);

    return {
      statKey: 'getAccount',
      method: 'GET',
      url: `${config.generalBaseUrl}/accounts/${accountId}`,
      body: null,
    };
  }

  if (picked === 'postTransfer') {
    return {
      statKey: 'postTransfer',
      method: 'POST',
      url: `${config.transferBaseUrl}/transfers`,
      body: buildTransferBody(
        config.minAccountId,
        config.maxAccountId,
        config.amount
      ),
    };
  }

  if (picked === 'getTransferJob') {
    const jobId = jobPool.pick();

    if (!jobId) {
      const fallbackAccountId = randomInt(config.minAccountId, config.maxAccountId);

      return {
        statKey: 'getAccount',
        method: 'GET',
        url: `${config.generalBaseUrl}/accounts/${fallbackAccountId}`,
        body: null,
      };
    }

    return {
      statKey: 'getTransferJob',
      method: 'GET',
      url: `${config.generalBaseUrl}/transfer-jobs/${jobId}`,
      body: null,
    };
  }

  if (picked === 'getTransferHistory') {
    const accountId = randomInt(config.minAccountId, config.maxAccountId);

    return {
      statKey: 'getTransferHistory',
      method: 'GET',
      url: `${config.generalBaseUrl}/transfers?accountId=${accountId}`,
      body: null,
    };
  }

  if (picked === 'postUser') {
    return {
      statKey: 'postUser',
      method: 'POST',
      url: `${config.generalBaseUrl}/users`,
      body: buildUserBody(userSeq),
    };
  }

  return {
    statKey: 'postAccount',
    method: 'POST',
    url: `${config.generalBaseUrl}/accounts`,
    body: buildAccountBody(
      config.minUserId,
      config.maxUserId,
      config.initialBalance
    ),
  };
}

async function sendRequest(request) {
  const headers = {};

  let body;

  if (request.body !== null) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(request.body);
  }

  const response = await fetch(request.url, {
    method: request.method,
    headers,
    body,
  });

  const text = await response.text();

  return {
    status: response.status,
    ok: response.ok,
    text,
  };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_err) {
    return null;
  }
}

function bumpStatus(stats, status) {
  const key = String(status);

  stats.statusCodes[key] = (stats.statusCodes[key] || 0) + 1;
}

function markEndpoint(stats, statKey, ok) {
  const bucket = stats.endpointStats[statKey];

  if (!bucket) {
    return;
  }

  bucket.total += 1;

  if (ok) {
    bucket.success += 1;
  } else {
    bucket.failed += 1;
  }
}

async function workerLoop(config, stats, jobPool, state) {
  while (performance.now() < state.deadlineMs) {
    const request = buildRequest(config, jobPool, state.userSeq);

    state.userSeq += 1;
    stats.totalRequests += 1;

    try {
      const result = await sendRequest(request);

      bumpStatus(stats, result.status);
      markEndpoint(stats, request.statKey, result.ok);

      if (result.ok) {
        stats.successRequests += 1;
      } else {
        stats.failedRequests += 1;
      }

      if (request.statKey === 'postTransfer') {
        const parsed = safeJsonParse(result.text);

        if (
          parsed &&
          parsed.ok === true &&
          parsed.data &&
          parsed.data.jobId
        ) {
          jobPool.push(parsed.data.jobId);
          stats.transferJobsCreated += 1;
        }
      }

      if (request.statKey === 'getTransferJob' && result.ok) {
        stats.transferJobPollHits += 1;
      }
    } catch (_err) {
      stats.requestErrors += 1;
      stats.failedRequests += 1;
      markEndpoint(stats, request.statKey, false);
    }
  }
}

function printStatusCodes(statusCodes) {
  const keys = Object.keys(statusCodes).sort((a, b) => Number(a) - Number(b));

  console.log('\n=== Status Codes ===');

  if (keys.length === 0) {
    console.log('No status codes recorded');
    return;
  }

  for (const key of keys) {
    console.log(`${key}: ${statusCodes[key]}`);
  }
}

function printEndpointStats(endpointStats) {
  console.log('\n=== Endpoint Breakdown ===');
  console.log('| Endpoint | Total | Success | Failed |');
  console.log('|------|------:|------:|------:|');

  const mapping = [
    [ 'getAccount', 'GET /accounts/:id' ],
    [ 'postTransfer', 'POST /transfers' ],
    [ 'getTransferJob', 'GET /transfer-jobs/:jobId' ],
    [ 'getTransferHistory', 'GET /transfers?accountId=...' ],
    [ 'postUser', 'POST /users' ],
    [ 'postAccount', 'POST /accounts' ],
  ];

  for (const [ key, label ] of mapping) {
    const item = endpointStats[key];
    console.log(`| ${label} | ${item.total} | ${item.success} | ${item.failed} |`);
  }
}

async function main() {
  const defaultGeneralBaseUrl = getArg('url', 'http://127.0.0.1:7001');
  const config = {
    generalBaseUrl: getArg('generalUrl', defaultGeneralBaseUrl),
    transferBaseUrl: getArg('transferUrl', 'http://127.0.0.1:7010'),
    connections: toPositiveInt(getArg('connections', '100'), 100),
    durationSeconds: toPositiveInt(getArg('duration', '60'), 60),
    minAccountId: toPositiveInt(getArg('minAccountId', '1'), 1),
    maxAccountId: toPositiveInt(getArg('maxAccountId', '1000'), 1000),
    minUserId: toPositiveInt(getArg('minUserId', '1'), 1),
    maxUserId: toPositiveInt(getArg('maxUserId', '1000'), 1000),
    amount: toPositiveInt(getArg('amount', '1'), 1),
    initialBalance: toPositiveInt(getArg('initialBalance', '1000'), 1000),
    jobPoolLimit: toPositiveInt(getArg('jobPoolLimit', '5000'), 5000),
  };

  const stats = createStats();
  const jobPool = createJobPool(config.jobPoolLimit);

  console.log('========================================');
  console.log('Final Random Request Benchmark');
  console.log('========================================');
  console.log(`general url    : ${config.generalBaseUrl}`);
  console.log(`transfer url   : ${config.transferBaseUrl}`);
  console.log(`connections    : ${config.connections}`);
  console.log(`duration       : ${config.durationSeconds}s`);
  console.log(`account range  : ${config.minAccountId} ~ ${config.maxAccountId}`);
  console.log(`user range     : ${config.minUserId} ~ ${config.maxUserId}`);
  console.log(`amount         : ${config.amount}`);
  console.log('');

  stats.startedAt = performance.now();

  const state = {
    deadlineMs: stats.startedAt + (config.durationSeconds * 1000),
    userSeq: 1,
  };

  const workers = [];

  for (let i = 0; i < config.connections; i += 1) {
    workers.push(workerLoop(config, stats, jobPool, state));
  }

  await Promise.all(workers);

  stats.endedAt = performance.now();

  const elapsedSeconds = (stats.endedAt - stats.startedAt) / 1000;
  const avgTotalRps = stats.totalRequests / elapsedSeconds;
  const avgSuccessRps = stats.successRequests / elapsedSeconds;

  console.log('\n=== Summary ===');
  console.log(`elapsed.seconds : ${elapsedSeconds.toFixed(2)}`);
  console.log(`requests.total  : ${stats.totalRequests}`);
  console.log(`requests.success: ${stats.successRequests}`);
  console.log(`requests.failed : ${stats.failedRequests}`);
  console.log(`request.errors  : ${stats.requestErrors}`);
  console.log(`rps.total       : ${avgTotalRps.toFixed(2)}`);
  console.log(`rps.success     : ${avgSuccessRps.toFixed(2)}`);
  console.log(`jobPool.size    : ${jobPool.size()}`);
  console.log(`jobs.created    : ${stats.transferJobsCreated}`);
  console.log(`job.poll.hits   : ${stats.transferJobPollHits}`);

  printStatusCodes(stats.statusCodes);
  printEndpointStats(stats.endpointStats);
}

main().catch(err => {
  console.error('[final_random_request_benchmark] failed:', err.message);
  process.exit(1);
});
