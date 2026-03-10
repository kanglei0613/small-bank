'use strict';

// Redis Transfer Queue
//
// 作用：
// - 使用 Redis list 作為 per-fromId queue
// - 使用 Redis owner lock 避免多個 process 同時 drain 同一條 queue
// - drain 時依序取出 job
// - 呼叫 handler(job) 執行真正的 transfer job
//
// queue key 範例：
// transfer:queue:from:6
//
// owner key 範例：
// transfer:queue:owner:from:6

const OWNER_TTL_MS = 10000;

// 建立 queue key
function buildQueueKey(fromId) {
  return `transfer:queue:from:${fromId}`;
}

// 建立 owner key
function buildOwnerKey(fromId) {
  return `transfer:queue:owner:from:${fromId}`;
}

// 建立 owner value
// 用 pid + 時間 + 隨機字串，避免不同 worker 混淆
function buildOwnerValue() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// 將 job push 進 queue
async function pushJob(redis, fromId, job) {
  const queueKey = buildQueueKey(fromId);
  await redis.rpush(queueKey, JSON.stringify(job));
}

// 從 queue 左邊取出一筆 job
async function popJob(redis, fromId) {
  const queueKey = buildQueueKey(fromId);
  const raw = await redis.lpop(queueKey);

  if (!raw) {
    return null;
  }

  return JSON.parse(raw);
}

// 取得 queue 長度
async function getQueueLength(redis, fromId) {
  const queueKey = buildQueueKey(fromId);
  return await redis.llen(queueKey);
}

// 嘗試取得某個 fromId queue 的 owner
// 成功代表可以開始 drain
async function tryAcquireOwner(redis, fromId, ownerValue) {
  const ownerKey = buildOwnerKey(fromId);

  const result = await redis.set(
    ownerKey,
    ownerValue,
    'PX',
    OWNER_TTL_MS,
    'NX'
  );

  return result === 'OK';
}

// 延長 owner lock 的 TTL
// 只有當 owner value 一致時才會延長，避免誤續別人的 lock
async function refreshOwner(redis, fromId, ownerValue) {
  const ownerKey = buildOwnerKey(fromId);

  const lua = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("PEXPIRE", KEYS[1], ARGV[2])
    else
      return 0
    end
  `;

  const result = await redis.eval(
    lua,
    1,
    ownerKey,
    ownerValue,
    String(OWNER_TTL_MS)
  );

  return result === 1;
}

// 釋放 owner lock
// 只有 value 一致才刪除，避免刪到別人的 lock
async function releaseOwner(redis, fromId, ownerValue) {
  const ownerKey = buildOwnerKey(fromId);

  const lua = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    else
      return 0
    end
  `;

  await redis.eval(
    lua,
    1,
    ownerKey,
    ownerValue
  );
}

// 真正開始 drain queue
//
// 流程：
// 1. 持續從 queue 取 job
// 2. 每次處理前先刷新 owner lock TTL
// 3. 呼叫 handler(job)
// 4. queue 空了就結束
// 5. finally 釋放 owner
async function drainQueue({ ctx, fromId, handler, ownerValue }) {
  const { app, logger } = ctx;
  const redis = app.redis;

  try {
    let shouldContinue = true;

    while (shouldContinue) {
      // 先刷新 owner lock
      // 避免 queue 處理較久時 owner 過期
      const refreshed = await refreshOwner(redis, fromId, ownerValue);

      if (!refreshed) {
        logger.warn(
          '[RedisQueue] owner lost before pop: fromId=%s owner=%s',
          fromId,
          ownerValue
        );
        shouldContinue = false;
        continue;
      }

      // 取出一筆 job
      const job = await popJob(redis, fromId);

      // queue 空了就結束
      if (!job) {
        logger.info(
          '[RedisQueue] queue empty: fromId=%s',
          fromId
        );
        shouldContinue = false;
        continue;
      }

      logger.info(
        '[RedisQueue] processing job: fromId=%s jobId=%s',
        fromId,
        job.jobId
      );

      try {
        // 交給外部 handler 執行真正工作
        await handler(job);
      } catch (err) {
        // 這裡只記錄 log
        // job 狀態更新應由 handler 內部處理
        logger.error(
          '[RedisQueue] job handler error: fromId=%s jobId=%s err=%s',
          fromId,
          job.jobId,
          err && err.message
        );
      }
    }
  } finally {
    // 最後釋放 owner
    await releaseOwner(redis, fromId, ownerValue);

    logger.info(
      '[RedisQueue] owner released: fromId=%s owner=%s',
      fromId,
      ownerValue
    );
  }
}

// 嘗試啟動 drain
//
// 說明：
// - 多個 request 都可能呼叫這個方法
// - 但只有一個 process 能成功取得 owner
// - 成功者才真正 drain 該 fromId queue
async function tryStartDrain({ ctx, fromId, handler }) {
  const { app, logger } = ctx;
  const redis = app.redis;
  const ownerValue = buildOwnerValue();

  const acquired = await tryAcquireOwner(redis, fromId, ownerValue);

  // 沒拿到 owner，代表已經有其他 process / worker 在 drain
  if (!acquired) {
    logger.info(
      '[RedisQueue] drain skipped, owner exists: fromId=%s',
      fromId
    );
    return false;
  }

  logger.info(
    '[RedisQueue] owner acquired: fromId=%s owner=%s',
    fromId,
    ownerValue
  );

  // 背景開始 drain
  // 這裡直接 await 也可以，但通常會由呼叫端自己決定要不要 await
  await drainQueue({
    ctx,
    fromId,
    handler,
    ownerValue,
  });

  return true;
}

module.exports = {
  buildQueueKey,
  buildOwnerKey,
  pushJob,
  popJob,
  getQueueLength,
  tryAcquireOwner,
  refreshOwner,
  releaseOwner,
  drainQueue,
  tryStartDrain,
};
