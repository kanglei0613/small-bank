'use strict';

// Redis Transfer Queue
//
// 作用：
// - 使用 Redis list 作為 per-fromId queue
// - 使用 Redis owner lock 避免多個 process 同時 drain 同一條 queue
// - 使用 ready queue 記錄目前可被 worker 處理的 fromId
// - worker 不再掃 active set，而是直接 BRPOP ready queue
// - drain 時依序取出 job
// - 呼叫 handler(job) 執行真正的 transfer job

// 建立 per-fromId queue key
function buildQueueKey(fromId) {
  return `transfer:queue:from:${fromId}`;
}

// 建立 owner lock key
function buildOwnerKey(fromId) {
  return `transfer:queue:owner:from:${fromId}`;
}

// 建立 ready queue key
//
// ready queue 只存「目前有工作可做的 fromId」
// worker 會阻塞在這條 queue 上，不再掃描 active set
function buildReadyQueueKey() {
  return 'transfer:queue:ready:fromIds';
}

// 建立 owner value
//
// 用 pid + timestamp + random string 當 owner value，方便辨識目前持鎖的是誰
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
    readyQueueBlockTimeoutSec: 1,
  };
}

// 將 job push 進 per-fromId queue
//
// 設計重點：
// - queue 長度達到 rejectThreshold → 直接拒絕
// - queue 長度達到 maxLength → 視為 full
// - 只有 queue 從空變成非空時，才把 fromId 推進 ready queue 一次
//
// 為什麼這樣做：
// - 避免 worker 不斷掃描所有 active fromId
// - ready queue 只在「這條 queue 原本是空的」時補一次 fromId
// - 同一條 queue 後續新增 job，不需要一直重複 push fromId 到 ready queue
async function pushJob(redis, fromId, job, options = {}) {
  const queueKey = buildQueueKey(fromId);
  const readyQueueKey = buildReadyQueueKey();
  const payload = JSON.stringify(job);

  const rejectThresholdPerFromId = options.rejectThresholdPerFromId || 240;
  const maxQueueLengthPerFromId = options.maxQueueLengthPerFromId || 300;

  const lua = `
    local queueKey = KEYS[1]
    local readyQueueKey = KEYS[2]
    local rejectThreshold = tonumber(ARGV[1])
    local maxLength = tonumber(ARGV[2])
    local payload = ARGV[3]
    local fromId = ARGV[4]

    local currentLength = redis.call("LLEN", queueKey)

    if currentLength >= rejectThreshold then
      return -2
    end

    if currentLength >= maxLength then
      return -1
    end

    local newLength = redis.call("RPUSH", queueKey, payload)

    if newLength == 1 then
      redis.call("LPUSH", readyQueueKey, fromId)
    end

    return newLength
  `;

  const result = await redis.eval(
    lua,
    2,
    queueKey,
    readyQueueKey,
    String(rejectThresholdPerFromId),
    String(maxQueueLengthPerFromId),
    payload,
    String(fromId)
  );

  if (result === -2) {
    const { ConflictError } = require('../lib/errors');
    throw new ConflictError('insufficient funds');
  }

  if (result === -1) {
    const { ConflictError } = require('../lib/errors');
    throw new ConflictError('insufficient funds');
  }

  return result;
}

// 從 queue 左邊取出一筆 job
async function popJob(redis, fromId) {
  const jobs = await popJobs(redis, fromId, 1);
  return jobs[0] || null;
}

// 使用 Lua 一次批次取出多筆 job
//
// 流程：
// - LRANGE 先取前 N 筆
// - 如果有資料，再用 LTRIM 把前 N 筆切掉
//
// 這樣比一筆一筆 LPOP 效率高
async function popJobs(redis, fromId, batchSize) {
  const queueKey = buildQueueKey(fromId);

  const lua = `
    local n = tonumber(ARGV[1])
    local values = redis.call("LRANGE", KEYS[1], 0, n - 1)

    if #values == 0 then
      return values
    end

    redis.call("LTRIM", KEYS[1], n, -1)
    return values
  `;

  const raws = await redis.eval(
    lua,
    1,
    queueKey,
    String(batchSize)
  );

  if (!raws || raws.length === 0) {
    return [];
  }

  return raws.map(raw => JSON.parse(raw));
}

// 取得 queue 長度
async function getQueueLength(redis, fromId) {
  const queueKey = buildQueueKey(fromId);
  return await redis.llen(queueKey);
}

// 取得 queue stats
//
// 這裡不再看 active set，而是看：
// - queue length
// - owner lock
// - ready queue length
async function getQueueStats(redis, fromId, options = {}) {
  const queueKey = buildQueueKey(fromId);
  const ownerKey = buildOwnerKey(fromId);
  const readyQueueKey = buildReadyQueueKey();

  const [
    queueLength,
    ownerValue,
    ownerTTL,
    readyQueueLength,
  ] = await Promise.all([
    redis.llen(queueKey),
    redis.get(ownerKey),
    redis.pttl(ownerKey),
    redis.llen(readyQueueKey),
  ]);

  return {
    fromId,
    queueKey,
    ownerKey,
    readyQueueKey,
    queueLength,
    ownerExists: !!ownerValue,
    ownerValue: ownerValue || null,
    ownerTTL,
    readyQueueLength,
    rejectThresholdPerFromId: options.rejectThresholdPerFromId || 240,
    maxQueueLengthPerFromId: options.maxQueueLengthPerFromId || 300,
    ownerTtlMs: options.ownerTtlMs || 10000,
    ownerRefreshIntervalMs: options.ownerRefreshIntervalMs || 3000,
    batchSize: options.batchSize || 5,
  };
}

// 嘗試取得某個 fromId queue 的 owner
//
// 只有拿到 owner lock 的 worker，才能 drain 這條 queue
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
//
// 只有目前 ownerValue 還一致時才更新 TTL，避免誤刷新別人的鎖
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
//
// 只有 ownerValue 還一致時才刪除，避免誤刪別人的鎖
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
//
// 作用：
// - drain queue 可能會花一點時間
// - 背景定期刷新 owner TTL
// - 避免鎖在 drain 過程中自然過期
function startOwnerHeartbeat({ ctx, fromId, redis, ownerValue, options = {} }) {
  const { logger } = ctx;
  const ownerRefreshIntervalMs = options.ownerRefreshIntervalMs || 3000;
  const ownerTtlMs = options.ownerTtlMs || 10000;
  const onLost = options.onLost || null;

  let stopped = false;
  let timer = null;

  const tick = async () => {
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
        if (onLost) onLost();
      }
    } catch (err) {
      logger.error(
        '[RedisQueue] owner heartbeat error: fromId=%s owner=%s err=%s',
        fromId,
        ownerValue,
        err && err.message
      );
    }
  };

  // 第一次 heartbeat 延後到 ownerTtlMs 一半才觸發
  // 讓主迴圈先執行 popJobs，避免 setInterval 搶先佔用 event loop
  const initialDelay = ownerTtlMs; // 延後到整個 TTL，讓主迴圈完全不被干擾
  const initTimer = setTimeout(() => {
    if (stopped) return;
    tick();
    timer = setInterval(tick, ownerRefreshIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }, initialDelay);

  if (typeof initTimer.unref === 'function') initTimer.unref();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(initTimer);
      if (timer) clearInterval(timer);
    },
  };
}

//
// worker 會卡在這裡等待，不再掃 active set
async function blockPopReadyFromId(redis, timeoutSec) {
  const readyQueueKey = buildReadyQueueKey();
  const result = await redis.brpop(readyQueueKey, timeoutSec);

  if (!result || result.length < 2) {
    return null;
  }

  const fromId = Number(result[1]);

  if (!Number.isInteger(fromId) || fromId <= 0) {
    return null;
  }

  return fromId;
}

// drain queue
//
// 流程：
// - 先啟動 owner heartbeat
// - 每輪先 refresh owner，確認自己還持有鎖
// - 批次 pop jobs
// - 逐筆呼叫 handler(job)
// - queue 空了就結束
//
// 注意：
// - 這一版不再維護 active set
// - 也不再在 queue empty 時 removeActiveFromId
async function drainQueue({ ctx, fromId, redis, handler, ownerValue, options = {} }) {
  const { logger } = ctx;
  const ownerTtlMs = options.ownerTtlMs || 10000;
  const ownerRefreshIntervalMs = options.ownerRefreshIntervalMs || 3000;
  const batchSize = options.batchSize || 5;

  let ownerLost = false;

  const heartbeat = startOwnerHeartbeat({
    ctx,
    fromId,
    redis,
    ownerValue,
    options: {
      ownerTtlMs,
      ownerRefreshIntervalMs,
      onLost: () => { ownerLost = true; },
    },
  });

  try {
    while (!ownerLost) {
      const jobs = await popJobs(redis, fromId, batchSize);

      if (jobs.length === 0) {
        break;
      }

      for (const job of jobs) {
        if (ownerLost) break;
        try {
          await handler(job);
        } catch (err) {
          logger.error(
            '[RedisQueue] job handler error: fromId=%s jobId=%s err=%s',
            fromId,
            job.jobId,
            err && err.message
          );
        }
      }
    }

    if (ownerLost) {
      logger.warn(
        '[RedisQueue] owner lost during drain: fromId=%s owner=%s',
        fromId,
        ownerValue
      );
    }
  } finally {
    heartbeat.stop();
    await releaseOwner(redis, fromId, ownerValue);
  }
}


// 嘗試啟動 drain
//
// 流程：
// - worker 從 ready queue 取到 fromId
// - 嘗試取得 owner lock
// - 如果成功，就 drain 該 fromId queue
// - 如果失敗，表示已有其他 worker 在做，直接跳過
async function tryStartDrain({ ctx, fromId, redis, handler }) {
  const { app } = ctx;
  const ownerValue = buildOwnerValue();
  const transferQueueConfig = getTransferQueueConfig(app);

  const acquired = await tryAcquireOwner(redis, fromId, ownerValue, {
    ownerTtlMs: transferQueueConfig.ownerTtlMs,
  });

  if (!acquired) {
    return false;
  }

  await drainQueue({
    ctx,
    fromId,
    redis,
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
  buildReadyQueueKey,
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
  blockPopReadyFromId,
  drainQueue,
  tryStartDrain,
};
