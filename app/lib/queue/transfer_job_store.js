'use strict';

// Transfer Job Store
//
// 作用：
// - 將 transfer job 的狀態存在 Redis
// - 提供建立 job / 查詢 job / 更新 job 狀態的方法
//
// 設計目標：
// - createJob：直接寫入 queued job
// - markSuccess：直接覆蓋寫入 success job
// - markFailed：直接覆蓋寫入 failed job
// - 避免 update 時先 GET 再 SET，減少 Redis round-trip
//
// Redis key 範例：
// transfer:job:abc123

const JOB_TTL_SECONDS = 60 * 60 * 24; // Job 的 TTL

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
  const key = buildJobKey(jobId); // 建立 Job key
  const raw = await redis.get(key); // 非同步等待 Redis 回傳 key 對應值

  // 空值處理
  if (!raw) {
    return null;
  }

  return JSON.parse(raw); // 將拿到的 JSON 字串轉回 JS 物件，可以拿到欄位中的物件，方便直接讀取
}

// 建立新 job
//
// 這裡直接寫入 queued 狀態，不做額外查詢
async function createJob(redis, job) {
  const nextJob = {
    jobId: job.jobId,
    status: job.status || 'queued',
    fromId: job.fromId,
    toId: job.toId,
    amount: job.amount,
    createdAt: job.createdAt || Date.now(),
    updatedAt: job.updatedAt || job.createdAt || Date.now(),
    result: job.result || null, // 尚未有結果
    error: job.error || null, // 尚未有錯誤
  };

  await setJob(redis, nextJob); // 寫入 Redis
  return nextJob;
}

// 將 job 標記為 success
//
// 直接覆蓋寫入最終結果，避免先 GET 再 SET
async function markSuccess(redis, job, result) {
  const now = Date.now();

  // 把Job 狀態標記為成功
  const nextJob = {
    jobId: job.jobId,
    status: 'success',
    fromId: job.fromId,
    toId: job.toId,
    amount: job.amount,
    createdAt: job.createdAt,
    updatedAt: now,
    result,
    error: null,
  };

  const pl = redis.pipeline(); // 使用 pipeline 減少網路開銷
  pl.set(buildJobKey(nextJob.jobId), JSON.stringify(nextJob), 'EX', JOB_TTL_SECONDS); // 更新 Redis 裡的 JSON 字串
  pl.publish(`transfer:job:done:${job.jobId}`, JSON.stringify(nextJob)); // 發佈訊息到特定頻道，通知 SSE 連線
  await pl.exec();
  return nextJob;
}

// 將 job 標記為 failed
//
// 直接覆蓋寫入最終結果，避免先 GET 再 SET
async function markFailed(redis, job, err) {
  const now = Date.now();

  const nextJob = {
    jobId: job.jobId,
    status: 'failed',
    fromId: job.fromId,
    toId: job.toId,
    amount: job.amount,
    createdAt: job.createdAt,
    updatedAt: now,
    result: null,
    error: {
      message: err && err.message ? err.message : 'unknown error',
      status: err && err.status ? err.status : null,
      code: err && err.code ? err.code : null,
    },
  };

  const pl = redis.pipeline(); // 開啟 pipeline 暫存區
  pl.set(buildJobKey(nextJob.jobId), JSON.stringify(nextJob), 'EX', JOB_TTL_SECONDS); // 把 Job 的最新狀態轉乘 JSON 字串存入 Redis
  pl.publish(`transfer:job:done:${job.jobId}`, JSON.stringify(nextJob)); // 發動 Pub 給對應的頻道
  await pl.exec(); // 執行 Pipeline
  return nextJob;
}

module.exports = {
  buildJobKey,
  getJob,
  createJob,
  markSuccess,
  markFailed,
};
