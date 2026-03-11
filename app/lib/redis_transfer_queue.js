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

// 讀取 transfer queue config
function getTransferQueueConfig(app) {
  return app.config.transferQueue || {
    rejectThresholdPerFromId: 240,
    maxQueueLengthPerFromId: 300,
    ownerTtlMs: 10000,
    ownerRefreshIntervalMs: 3000,
    batchSize: 20,
  };
}

// 將 job push 進 queue
//
// 注意：
// - 使用 Lua script 確保「檢查 queue 長度 + push」是原子操作
// - 先做 admission control，再做 hard limit
async function pushJob(redis, fromId, job, options = {}) {
  const queueKey = buildQueueKey(fromId);
  const payload = JSON.stringify(job);

  const rejectThresholdPerFromId = options.rejectThresholdPerFromId || 240;
  const maxQueueLengthPerFromId = options.maxQueueLengthPerFromId || 300;

  const lua = `
    local currentLength = redis.call("LLEN", KEYS[1])
    local rejectThreshold = tonumber(ARGV[1])
    local maxLength = tonumber(ARGV[2])

    -- admission control：提早拒絕
    if currentLength >= rejectThreshold then
      return -2
    end

    -- hard limit：最終上限
    if currentLength >= maxLength then
      return -1
    end

    redis.call("RPUSH", KEYS[1], ARGV[3])

    return currentLength + 1
  `;

  const result = await redis.eval(
    lua,
    1,
    queueKey,
    String(rejectThresholdPerFromId),
    String(maxQueueLengthPerFromId),
    payload
  );

  // admission control：提早拒絕
  if (result === -2) {
    const err = new Error('queue admission rejected');
    err.status = 429;
    err.code = 'QUEUE_ADMISSION_REJECTED';
    throw err;
  }

  // hard limit：queue 已滿
  if (result === -1) {
    const err = new Error('queue is full for this account');
    err.status = 429;
    err.code = 'QUEUE_FULL';
    throw err;
  }

  return result;
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

// 從 queue 左邊批次取出多筆 job
async function popJobs(redis, fromId, batchSize) {
  const queueKey = buildQueueKey(fromId);

  const jobs = [];

  for (let i = 0; i < batchSize; i++) {
    const raw = await redis.lpop(queueKey);

    if (!raw) {
      break;
    }

    jobs.push(JSON.parse(raw));
  }

  return jobs;
}

// 取得 queue 長度
async function getQueueLength(redis, fromId) {
  const queueKey = buildQueueKey(fromId);
  return await redis.llen(queueKey);
}

// 取得 queue stats
async function getQueueStats(redis, fromId, options = {}) {
  const queueKey = buildQueueKey(fromId);
  const ownerKey = buildOwnerKey(fromId);

  const [
    queueLength,
    ownerValue,
    ownerTTL,
  ] = await Promise.all([
    redis.llen(queueKey),
    redis.get(ownerKey),
    redis.pttl(ownerKey),
  ]);

  return {
    fromId,
    queueKey,
    ownerKey,
    queueLength,
    ownerExists: !!ownerValue,
    ownerValue: ownerValue || null,
    ownerTTL,
    rejectThresholdPerFromId: options.rejectThresholdPerFromId || 240,
    maxQueueLengthPerFromId: options.maxQueueLengthPerFromId || 300,
    ownerTtlMs: options.ownerTtlMs || 10000,
    ownerRefreshIntervalMs: options.ownerRefreshIntervalMs || 3000,
    batchSize: options.batchSize || 5,
  };
}

// 嘗試取得某個 fromId queue 的 owner
async function tryAcquireOwner(redis, fromId, ownerValue, options = {}) {
  const ownerKey = buildOwnerKey(fromId);
  const ownerTtlMs = options.ownerTtlMs || 10000;

  const result = await redis.set(
    ownerKey,
    ownerValue,
    'PX',
    ownerTtlMs,
    'NX'
  );

  return result === 'OK';
}

// 延長 owner lock TTL
async function refreshOwner(redis, fromId, ownerValue, options = {}) {
  const ownerKey = buildOwnerKey(fromId);
  const ownerTtlMs = options.ownerTtlMs || 10000;

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
    String(ownerTtlMs)
  );

  return result === 1;
}

// 釋放 owner lock
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

// 啟動 owner heartbeat
function startOwnerHeartbeat({ ctx, fromId, ownerValue, options = {} }) {
  const { app, logger } = ctx;
  const redis = app.redis;
  const ownerRefreshIntervalMs = options.ownerRefreshIntervalMs || 3000;
  const ownerTtlMs = options.ownerTtlMs || 10000;

  let stopped = false;

  const timer = setInterval(async () => {
    if (stopped) return;

    try {
      const refreshed = await refreshOwner(redis, fromId, ownerValue, {
        ownerTtlMs,
      });

      if (!refreshed) {
        logger.warn(
          '[RedisQueue] owner heartbeat lost: fromId=%s owner=%s',
          fromId,
          ownerValue
        );
      } else {
        logger.info(
          '[RedisQueue] owner heartbeat refreshed: fromId=%s owner=%s',
          fromId,
          ownerValue
        );
      }
    } catch (err) {
      logger.error(
        '[RedisQueue] owner heartbeat error: fromId=%s owner=%s err=%s',
        fromId,
        ownerValue,
        err && err.message
      );
    }
  }, ownerRefreshIntervalMs);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}

// drain queue
async function drainQueue({ ctx, fromId, handler, ownerValue, options = {} }) {
  const { app, logger } = ctx;
  const redis = app.redis;
  const ownerTtlMs = options.ownerTtlMs || 10000;
  const ownerRefreshIntervalMs = options.ownerRefreshIntervalMs || 3000;
  const batchSize = options.batchSize || 5;

  try {
    let shouldContinue = true;

    while (shouldContinue) {
      const refreshed = await refreshOwner(redis, fromId, ownerValue, {
        ownerTtlMs,
      });

      if (!refreshed) {
        logger.warn(
          '[RedisQueue] owner lost before pop: fromId=%s owner=%s',
          fromId,
          ownerValue
        );
        shouldContinue = false;
        continue;
      }

      const jobs = await popJobs(redis, fromId, batchSize);

      if (jobs.length === 0) {
        logger.info(
          '[RedisQueue] queue empty: fromId=%s',
          fromId
        );
        shouldContinue = false;
        continue;
      }

      logger.info(
        '[RedisQueue] batch fetched: fromId=%s batchSize=%s',
        fromId,
        jobs.length
      );

      for (const job of jobs) {
        logger.info(
          '[RedisQueue] processing job: fromId=%s jobId=%s',
          fromId,
          job.jobId
        );

        const heartbeat = startOwnerHeartbeat({
          ctx,
          fromId,
          ownerValue,
          options: {
            ownerTtlMs,
            ownerRefreshIntervalMs,
          },
        });

        try {
          await handler(job);
        } catch (err) {
          logger.error(
            '[RedisQueue] job handler error: fromId=%s jobId=%s err=%s',
            fromId,
            job.jobId,
            err && err.message
          );
        } finally {
          heartbeat.stop();
        }
      }
    }
  } finally {
    await releaseOwner(redis, fromId, ownerValue);

    logger.info(
      '[RedisQueue] owner released: fromId=%s owner=%s',
      fromId,
      ownerValue
    );
  }
}

// 嘗試啟動 drain
async function tryStartDrain({ ctx, fromId, handler }) {
  const { app, logger } = ctx;
  const redis = app.redis;
  const ownerValue = buildOwnerValue();
  const transferQueueConfig = getTransferQueueConfig(app);

  const acquired = await tryAcquireOwner(redis, fromId, ownerValue, {
    ownerTtlMs: transferQueueConfig.ownerTtlMs,
  });

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

  await drainQueue({
    ctx,
    fromId,
    handler,
    ownerValue,
    options: {
      ownerTtlMs: transferQueueConfig.ownerTtlMs,
      ownerRefreshIntervalMs: transferQueueConfig.ownerRefreshIntervalMs,
      batchSize: transferQueueConfig.batchSize,
    },
  });

  return true;
}

module.exports = {
  buildQueueKey,
  buildOwnerKey,
  buildOwnerValue,
  getTransferQueueConfig,
  pushJob,
  popJob,
  popJobs,
  getQueueLength,
  getQueueStats,
  tryAcquireOwner,
  refreshOwner,
  releaseOwner,
  startOwnerHeartbeat,
  drainQueue,
  tryStartDrain,
};
