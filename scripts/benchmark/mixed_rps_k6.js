/**
 * mixed_rps_bench.js
 *
 * 混合請求壓測，模擬真實流量分布：
 *   35% GET  /accounts/:id          (general API, 7001) — Redis cache
 *   25% POST /transfers             (transfer API, 7010) — async queue
 *   20% GET  /transfers?accountId=  (general API, 7001) — DB query
 *   10% GET  /transfer-jobs/:jobId  (general API, 7001) — Redis job store
 *   05% POST /users                 (general API, 7001) — meta DB write
 *   05% POST /accounts              (general API, 7001) — meta + shard DB write
 *
 * 執行方式：
 *   k6 run scripts/benchmark/mixed_rps_bench.js
 *
 * 自訂參數（open model）：
 *   ./mixed_bench.sh --executor=open --rate=5000 --duration=30s
 *
 * 自訂參數（closed model）：
 *   ./mixed_bench.sh --executor=closed --vus=100 --duration=30s
 */

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// =============================================================================
// 設定
// =============================================================================

const GENERAL_URL  = __ENV.GENERAL_URL  || 'http://127.0.0.1:7001';
const TRANSFER_URL = __ENV.TRANSFER_URL || 'http://127.0.0.1:7010';
const MIN_ID       = parseInt(__ENV.MIN_ID      || '33288');
const MAX_ID       = parseInt(__ENV.MAX_ID      || '136912');
const MIN_USER_ID  = parseInt(__ENV.MIN_USER_ID || '1');
const MAX_USER_ID  = parseInt(__ENV.MAX_USER_ID || '104042');
const AMOUNT       = parseInt(__ENV.AMOUNT      || '1');
const INIT_BAL     = parseInt(__ENV.INIT_BAL    || '10000');
const EXECUTOR     = __ENV.EXECUTOR || 'closed';

export const options = {
  scenarios: EXECUTOR === 'open'
    ? {
        default: {
          executor: 'constant-arrival-rate',
          rate: parseInt(__ENV.RATE || '3000'),
          timeUnit: '1s',
          duration: __ENV.DURATION || '60s',
          preAllocatedVUs: parseInt(__ENV.PRE_VUS  || '200'),
          maxVUs:          parseInt(__ENV.MAX_VUS  || '1000'),
        },
      }
    : {
        default: {
          executor: 'constant-vus',
          vus:      parseInt(__ENV.VUS || '50'),
          duration: __ENV.DURATION || '30s',
        },
      },

  thresholds: {
    http_req_failed:                        [{ threshold: 'rate<0.05', abortOnFail: false }],
    http_req_duration:                      ['p(95)<500'],
    'http_req_failed{endpoint:transfer}':   [{ threshold: 'rate<0.10', abortOnFail: false }],
  },
};

// =============================================================================
// 自訂 metrics
// =============================================================================

const transferSuccess  = new Counter('transfer_success');
const transferFailed   = new Counter('transfer_failed');
const transferDuration = new Trend('transfer_duration_ms', true);
const cacheHitRate     = new Rate('account_cache_hit');

// per-VU jobId pool（非同步 transfer 用，存 jobId 以便後續查詢）
const jobIds = [];
const JOB_POOL_LIMIT = 200;

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

function pushJobId(jobId) {
  if (!jobId) return;
  jobIds.push(jobId);
  if (jobIds.length > JOB_POOL_LIMIT) jobIds.shift();
}

function pickJobId() {
  if (jobIds.length === 0) return null;
  return jobIds[randInt(0, jobIds.length - 1)];
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// =============================================================================
// 各 endpoint 執行函式
// =============================================================================

function doGetAccount() {
  const aid = randAccountId();
  const res = http.get(
    `${GENERAL_URL}/accounts/${aid}`,
    { tags: { endpoint: 'get_account' } }
  );

  check(res, {
    'get_account: status 200 or 404': r => r.status === 200 || r.status === 404,
  });

  cacheHitRate.add(res.timings.duration < 5);
}

function doPostTransfer() {
  const fromId = randAccountId();
  let toId = randAccountId();
  while (toId === fromId) toId = randAccountId();

  const res = http.post(
    `${TRANSFER_URL}/transfers`,
    JSON.stringify({ fromId, toId, amount: AMOUNT }),
    { headers: JSON_HEADERS, tags: { endpoint: 'transfer' } }
  );

  transferDuration.add(res.timings.duration);

  check(res, {
    'transfer: status 202 or 409': r => r.status === 202 || r.status === 409,
  });

  if (res.status === 202) {
    transferSuccess.add(1);
    try {
      const body = JSON.parse(res.body);
      if (body && body.data && body.data.jobId) {
        pushJobId(body.data.jobId);
      }
    } catch (_) {}
  } else if (res.status !== 409) {
    transferFailed.add(1);
  }
}

function doGetTransfers() {
  const aid = randAccountId();
  const res = http.get(
    `${GENERAL_URL}/transfers?accountId=${aid}`,
    { tags: { endpoint: 'get_transfers' } }
  );

  check(res, {
    'get_transfers: status 200 or 404': r => r.status === 200 || r.status === 404,
  });
}

function doGetTransferJob() {
  const jobId = pickJobId();

  // job pool 還是空的，fallback 到 GET /accounts
  if (!jobId) {
    doGetAccount();
    return;
  }

  const res = http.get(
    `${GENERAL_URL}/transfer-jobs/${jobId}`,
    { tags: { endpoint: 'get_transfer_job' } }
  );

  check(res, {
    'get_transfer_job: status 200 or 404': r => r.status === 200 || r.status === 404,
  });
}

function doPostUser() {
  const name = `bench-user-${Date.now()}-${randInt(1, 999999)}`;
  const res = http.post(
    `${GENERAL_URL}/users`,
    JSON.stringify({ name }),
    { headers: JSON_HEADERS, tags: { endpoint: 'post_user' } }
  );

  check(res, {
    'post_user: status 201': r => r.status === 201,
  });
}

function doPostAccount() {
  const res = http.post(
    `${GENERAL_URL}/accounts`,
    JSON.stringify({
      userId: randInt(MIN_USER_ID, MAX_USER_ID),
      initialBalance: INIT_BAL,
    }),
    { headers: JSON_HEADERS, tags: { endpoint: 'post_account' } }
  );

  check(res, {
    'post_account: status 201 or 404': r => r.status === 201 || r.status === 404,
  });
}

// =============================================================================
// 主流程
// =============================================================================

export default function () {
  const action = pickWeighted([
    { name: 'getAccount',     weight: 35 },
    { name: 'postTransfer',   weight: 25 },
    { name: 'getTransfers',   weight: 20 },
    { name: 'getTransferJob', weight: 10 },
    { name: 'postUser',       weight:  5 },
    { name: 'postAccount',    weight:  5 },
  ]);

  switch (action) {
    case 'getAccount':     doGetAccount();     break;
    case 'postTransfer':   doPostTransfer();   break;
    case 'getTransfers':   doGetTransfers();   break;
    case 'getTransferJob': doGetTransferJob(); break;
    case 'postUser':       doPostUser();       break;
    case 'postAccount':    doPostAccount();    break;
    default:               doGetAccount();
  }
}
