'use strict';

const { TooManyRequestsError } = require('../errors');

// Key builders
function buildQueueKey(fromId) { return `transfer:queue:from:${fromId}`; }
function buildOwnerKey(fromId) { return `transfer:queue:owner:from:${fromId}`; }
function buildReadyQueueKey() { return 'transfer:queue:ready:fromIds'; }
function buildOwnerValue() { return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`; }

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

// Push a job into the per-fromId queue.
//
// Uses a Lua script for atomicity: length check + push + ready-queue signal are one operation.
// The fromId is pushed to the ready queue only when the queue transitions from empty → non-empty,
// so the worker doesn't get redundant signals for every job.
async function pushJob(redis, fromId, job, options = {}) {
  const queueKey = buildQueueKey(fromId);
  const readyQueueKey = buildReadyQueueKey();
  const payload = JSON.stringify(job);
  const rejectThreshold = options.rejectThresholdPerFromId || 240;
  const maxLength = options.maxQueueLengthPerFromId || 300;

  const lua = `
    local currentLength = redis.call("LLEN", KEYS[1])
    if currentLength >= tonumber(ARGV[1]) then return -2 end
    if currentLength >= tonumber(ARGV[2]) then return -1 end
    local newLength = redis.call("RPUSH", KEYS[1], ARGV[3])
    if newLength == 1 then redis.call("LPUSH", KEYS[2], ARGV[4]) end
    return newLength
  `;

  const result = await redis.eval(
    lua,
    2,
    queueKey,
    readyQueueKey,
    String(rejectThreshold),
    String(maxLength),
    payload,
    String(fromId)
  );

  if (result === -2) {
    throw new TooManyRequestsError('transfer queue is full, please try again later');
  }

  if (result === -1) {
    throw new TooManyRequestsError('transfer queue is at capacity, please try again later');
  }

  return result;
}

// Pop a single job from the left of the queue.
async function popJob(redis, fromId) {
  const jobs = await popJobs(redis, fromId, 1);
  return jobs[0] || null;
}

// Atomically pop up to batchSize jobs from the left of the queue.
async function popJobs(redis, fromId, batchSize) {
  const queueKey = buildQueueKey(fromId);

  const lua = `
    local values = redis.call("LRANGE", KEYS[1], 0, tonumber(ARGV[1]) - 1)
    if #values == 0 then return values end
    redis.call("LTRIM", KEYS[1], tonumber(ARGV[1]), -1)
    return values
  `;

  const raws = await redis.eval(lua, 1, queueKey, String(batchSize));

  if (!raws || raws.length === 0) return [];
  return raws.map(raw => JSON.parse(raw));
}

async function getQueueLength(redis, fromId) {
  return await redis.llen(buildQueueKey(fromId));
}

async function getQueueStats(redis, fromId, options = {}) {
  const queueKey = buildQueueKey(fromId);
  const ownerKey = buildOwnerKey(fromId);
  const readyQueueKey = buildReadyQueueKey();

  const [ queueLength, ownerValue, ownerTTL, readyQueueLength ] = await Promise.all([
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

// Acquire the owner lock for a fromId queue (SET NX PX).
// Returns true if acquired, false if another worker already holds it.
async function tryAcquireOwner(redis, fromId, ownerValue, options = {}) {
  const result = await redis.set(
    buildOwnerKey(fromId),
    ownerValue,
    'PX', options.ownerTtlMs || 10000,
    'NX'
  );
  return result === 'OK';
}

// Extend the owner lock TTL, but only if ownerValue still matches.
async function refreshOwner(redis, fromId, ownerValue, options = {}) {
  const lua = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("PEXPIRE", KEYS[1], ARGV[2])
    end
    return 0
  `;
  const result = await redis.eval(
    lua, 1,
    buildOwnerKey(fromId),
    ownerValue,
    String(options.ownerTtlMs || 10000)
  );
  return result === 1;
}

// Release the owner lock, but only if ownerValue still matches.
async function releaseOwner(redis, fromId, ownerValue) {
  const lua = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    end
    return 0
  `;
  await redis.eval(lua, 1, buildOwnerKey(fromId), ownerValue);
}

// Run a background heartbeat that periodically refreshes the owner lock TTL.
// Returns a { stop() } handle. Call stop() when drain is complete.
//
// The first tick is delayed by ownerTtlMs so the main drain loop runs
// uninterrupted for a full TTL cycle before heartbeat starts.
function startOwnerHeartbeat({ ctx, fromId, redis, ownerValue, options = {} }) {
  const { logger } = ctx;
  const ownerTtlMs = options.ownerTtlMs || 10000;
  const ownerRefreshIntervalMs = options.ownerRefreshIntervalMs || 3000;
  const onLost = options.onLost || null;

  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const refreshed = await refreshOwner(redis, fromId, ownerValue, { ownerTtlMs });
      if (!refreshed) {
        logger.warn('[RedisQueue] owner heartbeat lost: fromId=%s owner=%s', fromId, ownerValue);
        if (onLost) onLost();
      }
    } catch (err) {
      logger.error('[RedisQueue] owner heartbeat error: fromId=%s owner=%s err=%s', fromId, ownerValue, err && err.message);
    }
  };

  const initTimer = setTimeout(() => {
    if (stopped) return;
    tick();
    timer = setInterval(tick, ownerRefreshIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }, ownerTtlMs);

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

// Block-pop a fromId from the ready queue (BRPOP). Returns null on timeout.
async function blockPopReadyFromId(redis, timeoutSec) {
  const result = await redis.brpop(buildReadyQueueKey(), timeoutSec);
  if (!result || result.length < 2) return null;

  const fromId = Number(result[1]);
  return (Number.isInteger(fromId) && fromId > 0) ? fromId : null;
}

// Drain all jobs from a fromId queue while holding the owner lock.
//
// - Runs a heartbeat to keep the lock alive during long drains.
// - Processes jobs in batches; calls handler(job) for each.
// - On finish (or owner loss), releases the lock and re-enqueues fromId
//   if jobs arrived mid-drain.
async function drainQueue({ ctx, fromId, redis, handler, ownerValue, options = {} }) {
  const { logger } = ctx;
  const ownerTtlMs = options.ownerTtlMs || 10000;
  const ownerRefreshIntervalMs = options.ownerRefreshIntervalMs || 3000;
  const batchSize = options.batchSize || 5;

  let ownerLost = false;

  const heartbeat = startOwnerHeartbeat({
    ctx, fromId, redis, ownerValue,
    options: { ownerTtlMs, ownerRefreshIntervalMs, onLost: () => { ownerLost = true; } },
  });

  try {
    while (!ownerLost) {
      const jobs = await popJobs(redis, fromId, batchSize);
      if (jobs.length === 0) break;

      for (const job of jobs) {
        if (ownerLost) break;
        try {
          await handler(job);
        } catch (err) {
          logger.error('[RedisQueue] job handler error: fromId=%s jobId=%s err=%s', fromId, job.jobId, err && err.message);
        }
      }
    }

    if (ownerLost) {
      logger.warn('[RedisQueue] owner lost during drain: fromId=%s owner=%s', fromId, ownerValue);
    }
  } finally {
    heartbeat.stop();
    await releaseOwner(redis, fromId, ownerValue);

    // If jobs arrived while we were draining, re-signal the ready queue.
    try {
      const remaining = await redis.llen(buildQueueKey(fromId));
      if (remaining > 0) {
        await redis.lpush(buildReadyQueueKey(), String(fromId));
      }
    } catch (err) {
      logger.error('[RedisQueue] failed to re-enqueue fromId after drain: fromId=%s err=%s', fromId, err && err.message);
    }
  }
}

// Try to acquire the owner lock and drain the queue for a given fromId.
// If another worker already holds the lock, returns false immediately.
async function tryStartDrain({ ctx, fromId, redis, handler }) {
  const { app } = ctx;
  const ownerValue = buildOwnerValue();
  const config = getTransferQueueConfig(app);

  const acquired = await tryAcquireOwner(redis, fromId, ownerValue, { ownerTtlMs: config.ownerTtlMs });
  if (!acquired) return false;

  await drainQueue({
    ctx, fromId, redis, handler, ownerValue,
    options: {
      ownerTtlMs: config.ownerTtlMs,
      ownerRefreshIntervalMs: config.ownerRefreshIntervalMs,
      batchSize: config.batchSize,
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
