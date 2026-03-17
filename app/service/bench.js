'use strict';

const Service = require('egg').Service;
const AccountsRepo = require('../repository/accountsRepo');
const redisTransferQueue = require('../lib/redis_transfer_queue');
const transferJobStore = require('../lib/transfer_job_store');

const BENCH_QUEUE_KEY = 'bench:transfer:queue';
const BENCH_JOB_TTL_SECONDS = 60 * 60;

function buildBenchJobKey(jobId) {
  return `bench:transfer:job:${jobId}`;
}

function buildJobId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function validateInput({ fromId, toId, amount }) {
  if (!Number.isInteger(fromId) || fromId <= 0) {
    const err = new Error('fromId must be a positive integer');
    err.status = 400;
    throw err;
  }

  if (!Number.isInteger(toId) || toId <= 0) {
    const err = new Error('toId must be a positive integer');
    err.status = 400;
    throw err;
  }

  if (!Number.isInteger(amount) || amount <= 0) {
    const err = new Error('amount must be a positive integer');
    err.status = 400;
    throw err;
  }

  if (fromId === toId) {
    const err = new Error('fromId and toId cannot be the same');
    err.status = 400;
    throw err;
  }
}

class BenchService extends Service {
  async redisRpush({ fromId, toId, amount }) {
    const { app } = this.ctx;

    validateInput({ fromId, toId, amount });

    const jobId = buildJobId();
    const now = Date.now();

    await app.redis.rpush(BENCH_QUEUE_KEY, JSON.stringify({
      jobId,
      fromId,
      toId,
      amount,
      createdAt: now,
    }));

    return {
      jobId,
      status: 'queued',
      mode: 'redis-rpush',
    };
  }

  async redisSetRpush({ fromId, toId, amount }) {
    const { app } = this.ctx;

    validateInput({ fromId, toId, amount });

    const jobId = buildJobId();
    const now = Date.now();

    await app.redis.set(
      buildBenchJobKey(jobId),
      JSON.stringify({
        jobId,
        fromId,
        toId,
        amount,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
        result: null,
        error: null,
      }),
      'EX',
      BENCH_JOB_TTL_SECONDS
    );

    await app.redis.rpush(BENCH_QUEUE_KEY, JSON.stringify({
      jobId,
      fromId,
      toId,
      amount,
      createdAt: now,
    }));

    return {
      jobId,
      status: 'queued',
      mode: 'redis-set-rpush',
    };
  }

  // 正式 queue pushJob()，但不寫 job store
  async redisFormalPush({ fromId, toId, amount }) {
    const { app } = this.ctx;

    validateInput({ fromId, toId, amount });

    const jobId = buildJobId();
    const now = Date.now();

    const job = {
      jobId,
      fromId,
      toId,
      amount,
      createdAt: now,
    };

    const transferQueueConfig = app.config.transferQueue || {
      rejectThresholdPerFromId: 240,
      maxQueueLengthPerFromId: 300,
    };

    await redisTransferQueue.pushJob(app.redis, fromId, job, {
      rejectThresholdPerFromId: transferQueueConfig.rejectThresholdPerFromId,
      maxQueueLengthPerFromId: transferQueueConfig.maxQueueLengthPerFromId,
    });

    return {
      jobId,
      status: 'queued',
      mode: 'redis-formal-push',
    };
  }

  // 正式 createJob + 正式 pushJob()，但不打 log
  async redisFormalPushWithJob({ fromId, toId, amount }) {
    const { app } = this.ctx;

    validateInput({ fromId, toId, amount });

    const jobId = buildJobId();
    const now = Date.now();

    const job = {
      jobId,
      fromId,
      toId,
      amount,
      createdAt: now,
    };

    await transferJobStore.createJob(app.redis, {
      jobId,
      fromId,
      toId,
      amount,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    });

    const transferQueueConfig = app.config.transferQueue || {
      rejectThresholdPerFromId: 240,
      maxQueueLengthPerFromId: 300,
    };

    await redisTransferQueue.pushJob(app.redis, fromId, job, {
      rejectThresholdPerFromId: transferQueueConfig.rejectThresholdPerFromId,
      maxQueueLengthPerFromId: transferQueueConfig.maxQueueLengthPerFromId,
    });

    return {
      jobId,
      status: 'queued',
      mode: 'redis-formal-push-with-job',
    };
  }

  // 模擬正式 enqueueTransfer 的主要邏輯，但不打 info log
  async transfersEnqueueNoLog({ fromId, toId, amount }) {
    const { app } = this.ctx;

    validateInput({ fromId, toId, amount });

    const transferQueueConfig = app.config.transferQueue || {
      rejectThresholdPerFromId: 240,
      maxQueueLengthPerFromId: 300,
    };

    const jobId = buildJobId();
    const now = Date.now();

    const job = {
      jobId,
      fromId,
      toId,
      amount,
      createdAt: now,
    };

    await transferJobStore.createJob(app.redis, {
      jobId,
      fromId,
      toId,
      amount,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    });

    await redisTransferQueue.pushJob(app.redis, fromId, job, {
      rejectThresholdPerFromId: transferQueueConfig.rejectThresholdPerFromId,
      maxQueueLengthPerFromId: transferQueueConfig.maxQueueLengthPerFromId,
    });

    return {
      jobId,
      status: 'queued',
      mode: 'transfers-enqueue-no-log',
    };
  }

  // 用 Redis pipeline 一次送出：
  // 1. SET job
  // 2. RPUSH queue
  // 3. SADD active set
  //
  // 目的：
  // - 測試 createJob + enqueue + active set 合併送出的 intake 成本
  // - 先不包含 formal pushJob 的 admission control / LLEN / Lua
  async redisPipelinePush({ fromId, toId, amount }) {
    const { app } = this.ctx;

    validateInput({ fromId, toId, amount });

    const jobId = buildJobId();
    const now = Date.now();

    const job = {
      jobId,
      fromId,
      toId,
      amount,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    };

    const jobKey = buildBenchJobKey(jobId);
    const queueKey = `transfer:queue:from:${fromId}`;
    const activeQueueSetKey = 'transfer:queue:active:fromIds';

    const pipeline = app.redis.pipeline();

    pipeline.set(
      jobKey,
      JSON.stringify(job),
      'EX',
      BENCH_JOB_TTL_SECONDS
    );

    pipeline.rpush(queueKey, JSON.stringify({
      jobId,
      fromId,
      toId,
      amount,
      createdAt: now,
    }));

    pipeline.sadd(activeQueueSetKey, String(fromId));

    await pipeline.exec();

    return {
      jobId,
      status: 'queued',
      mode: 'redis-pipeline-push',
    };
  }

  // 純 DB transaction benchmark：
  // 直接呼叫正式 transfer()，跳過 queue / job store / polling
  async dbTransfer({ fromId, toId, amount }) {
    validateInput({ fromId, toId, amount });

    const repo = new AccountsRepo(this.ctx);
    const result = await repo.transfer(fromId, toId, amount);

    return {
      mode: 'db-transfer',
      result,
    };
  }
}

module.exports = BenchService;
