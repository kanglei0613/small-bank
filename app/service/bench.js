'use strict';

const Service = require('egg').Service;
const TransfersRepo = require('../repository/transfersRepo');
const redisTransferQueue = require('../lib/queue/redis_transfer_queue');
const transferJobStore = require('../lib/queue/transfer_job_store');
const { BadRequestError } = require('../lib/errors');

const BENCH_QUEUE_KEY = 'bench:transfer:queue';
const BENCH_JOB_TTL_SECONDS = 60 * 60;

function buildJobKey(jobId) {
  return `bench:transfer:job:${jobId}`;
}

function buildJobId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function validateInput({ fromId, toId, amount }) {
  if (!Number.isInteger(fromId) || fromId <= 0) {
    throw new BadRequestError('fromId must be a positive integer');
  }
  if (!Number.isInteger(toId) || toId <= 0) {
    throw new BadRequestError('toId must be a positive integer');
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new BadRequestError('amount must be a positive integer');
  }
  if (fromId === toId) {
    throw new BadRequestError('fromId and toId cannot be the same');
  }
}

class BenchService extends Service {

  get queueConfig() {
    return this.ctx.app.config.transferQueue || {
      rejectThresholdPerFromId: 240,
      maxQueueLengthPerFromId: 300,
    };
  }

  async redisRpush({ fromId, toId, amount }) {
    validateInput({ fromId, toId, amount });

    const jobId = buildJobId();
    const now = Date.now();

    await this.ctx.app.redis.rpush(BENCH_QUEUE_KEY, JSON.stringify({
      jobId,
      fromId,
      toId,
      amount,
      createdAt: now,
    }));

    return { jobId, status: 'queued', mode: 'redis-rpush' };
  }

  async redisSetRpush({ fromId, toId, amount }) {
    validateInput({ fromId, toId, amount });

    const jobId = buildJobId();
    const now = Date.now();
    const { redis } = this.ctx.app;

    await redis.set(
      buildJobKey(jobId),
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

    await redis.rpush(BENCH_QUEUE_KEY, JSON.stringify({
      jobId,
      fromId,
      toId,
      amount,
      createdAt: now,
    }));

    return { jobId, status: 'queued', mode: 'redis-set-rpush' };
  }

  async redisFormalPush({ fromId, toId, amount }) {
    validateInput({ fromId, toId, amount });

    const jobId = buildJobId();
    const now = Date.now();

    await redisTransferQueue.pushJob(
      this.ctx.app.redis,
      fromId,
      { jobId, fromId, toId, amount, createdAt: now },
      this.queueConfig
    );

    return { jobId, status: 'queued', mode: 'redis-formal-push' };
  }

  async redisFormalPushWithJob({ fromId, toId, amount }) {
    validateInput({ fromId, toId, amount });

    const jobId = buildJobId();
    const now = Date.now();
    const { redis } = this.ctx.app;

    await transferJobStore.createJob(redis, {
      jobId,
      fromId,
      toId,
      amount,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    });

    await redisTransferQueue.pushJob(
      redis,
      fromId,
      { jobId, fromId, toId, amount, createdAt: now },
      this.queueConfig
    );

    return { jobId, status: 'queued', mode: 'redis-formal-push-with-job' };
  }

  async transfersEnqueueNoLog({ fromId, toId, amount }) {
    validateInput({ fromId, toId, amount });

    const jobId = buildJobId();
    const now = Date.now();
    const { redis } = this.ctx.app;

    await transferJobStore.createJob(redis, {
      jobId,
      fromId,
      toId,
      amount,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    });

    await redisTransferQueue.pushJob(
      redis,
      fromId,
      { jobId, fromId, toId, amount, createdAt: now },
      this.queueConfig
    );

    return { jobId, status: 'queued', mode: 'transfers-enqueue-no-log' };
  }

  async redisPipelinePush({ fromId, toId, amount }) {
    validateInput({ fromId, toId, amount });

    const jobId = buildJobId();
    const now = Date.now();
    const pipeline = this.ctx.app.redis.pipeline();

    pipeline.set(
      buildJobKey(jobId),
      JSON.stringify({
        jobId,
        fromId,
        toId,
        amount,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
      }),
      'EX',
      BENCH_JOB_TTL_SECONDS
    );

    pipeline.rpush(
      `transfer:queue:from:${fromId}`,
      JSON.stringify({ jobId, fromId, toId, amount, createdAt: now })
    );

    pipeline.sadd('transfer:queue:active:fromIds', String(fromId));

    await pipeline.exec();

    return { jobId, status: 'queued', mode: 'redis-pipeline-push' };
  }

  async dbTransfer({ fromId, toId, amount }) {
    validateInput({ fromId, toId, amount });

    const result = await new TransfersRepo(this.ctx).transfer(fromId, toId, amount);

    return { mode: 'db-transfer', result };
  }
}

module.exports = BenchService;
