'use strict';

// Transfer Job Store
//
// 作用：
// - 將 transfer job 的狀態存在 Redis
// - 提供建立 job / 查詢 job / 更新 job 狀態的方法
//
// Redis key 範例：
// transfer:job:abc123
//
// value 內容範例：
// {
//   "jobId": "abc123",
//   "status": "queued",
//   "fromId": 6,
//   "toId": 7,
//   "amount": 1,
//   "createdAt": 1710000000000,
//   "updatedAt": 1710000000000,
//   "result": null,
//   "error": null
// }

const JOB_TTL_SECONDS = 60 * 60 * 24;

// 建立 job key
function buildJobKey(jobId) {
  return `transfer:job:${jobId}`;
}

// 將物件寫入 Redis，並設定 TTL
async function setJob(redis, job) {
  const key = buildJobKey(job.jobId);

  await redis.set(
    key,
    JSON.stringify(job),
    'EX',
    JOB_TTL_SECONDS
  );
}

// 從 Redis 讀取 job
async function getJob(redis, jobId) {
  const key = buildJobKey(jobId);
  const raw = await redis.get(key);

  if (!raw) {
    return null;
  }

  return JSON.parse(raw);
}

// 建立新 job
async function createJob(redis, job) {
  await setJob(redis, job);
  return job;
}

// 更新 job 內容
async function updateJob(redis, jobId, patch) {
  const job = await getJob(redis, jobId);

  if (!job) {
    const err = new Error(`transfer job not found: ${jobId}`);
    err.status = 404;
    throw err;
  }

  const nextJob = {
    ...job,
    ...patch,
    updatedAt: Date.now(),
  };

  await setJob(redis, nextJob);
  return nextJob;
}

// 將 job 標記為 processing
async function markProcessing(redis, jobId) {
  return await updateJob(redis, jobId, {
    status: 'processing',
  });
}

// 將 job 標記為 success
async function markSuccess(redis, jobId, result) {
  return await updateJob(redis, jobId, {
    status: 'success',
    result,
    error: null,
  });
}

// 將 job 標記為 failed
async function markFailed(redis, jobId, err) {
  return await updateJob(redis, jobId, {
    status: 'failed',
    result: null,
    error: {
      message: err && err.message ? err.message : 'unknown error',
      status: err && err.status ? err.status : null,
    },
  });
}

module.exports = {
  buildJobKey,
  getJob,
  createJob,
  markProcessing,
  markSuccess,
  markFailed,
};
