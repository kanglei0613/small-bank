'use strict';

const Redis = require('ioredis');
const Service = require('egg').Service;
const TransfersRepo = require('../repository/transfersRepo');
const redisTransferQueue = require('../lib/queue/redis_transfer_queue');
const transferJobStore = require('../lib/queue/transfer_job_store');
const { BadRequestError } = require('../lib/errors');

function buildJobId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function validateTransferInput({ fromId, toId, amount }) {
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

class TransferService extends Service {

  constructor(ctx) {
    super(ctx);
    this.repo = new TransfersRepo(ctx);
  }

  async submitTransfer({ fromId, toId, amount }) {
    validateTransferInput({ fromId, toId, amount });

    const { app } = this.ctx;
    const shardCount = Number(app.config.sharding.shardCount);
    const fromShardId = fromId % shardCount;
    const toShardId = toId % shardCount;

    if (fromShardId === toShardId) {
      const result = await this.repo.transferSameShard({
        fromAccountId: fromId,
        toAccountId: toId,
        transferAmount: amount,
        shardId: fromShardId,
      });
      return { mode: 'sync', ...result };
    }

    const queued = await this.enqueueTransfer({ fromId, toId, amount });
    return { mode: 'async', ...queued };
  }

  async enqueueTransfer({ fromId, toId, amount }) {
    const { app } = this.ctx;

    validateTransferInput({ fromId, toId, amount });

    const queueConfig = app.config.transferQueue || {
      rejectThresholdPerFromId: 240,
      maxQueueLengthPerFromId: 300,
    };

    const jobId = buildJobId();
    const now = Date.now();

    await transferJobStore.createJob(app.redis, {
      jobId,
      fromId,
      toId,
      amount,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    });

    await redisTransferQueue.pushJob(
      app.redis,
      fromId,
      { jobId, fromId, toId, amount, createdAt: now },
      {
        rejectThresholdPerFromId: queueConfig.rejectThresholdPerFromId,
        maxQueueLengthPerFromId: queueConfig.maxQueueLengthPerFromId,
      }
    );

    return { jobId, status: 'queued' };
  }

  async executeTransfer({ fromId, toId, amount }) {
    return await this.repo.transfer(fromId, toId, amount);
  }

  async processJob(job, redis) {
    const { logger } = this.ctx;
    const { jobId, fromId, toId, amount } = job;

    const start = Date.now();

    try {
      const result = await this.repo.transfer(fromId, toId, amount);

      const duration = Date.now() - start;
      logger.info(
        '[TransferJob] success: jobId=%s fromId=%s toId=%s duration=%dms',
        jobId, fromId, toId, duration
      );

      await transferJobStore.markSuccess(redis, job, result);
      await redis.incr('bench:transfer:success');

      return result;
    } catch (err) {
      const duration = Date.now() - start;
      logger.error(
        '[TransferJob] failed: jobId=%s fromId=%s toId=%s duration=%dms err=%s',
        jobId, fromId, toId, duration, err && err.message
      );

      await transferJobStore.markFailed(redis, job, err);
      await redis.incr('bench:transfer:failed');

      throw err;
    }
  }

  async tryDrainOneFromIdQueue(fromId, redis) {
    return await redisTransferQueue.tryStartDrain({
      ctx: this.ctx,
      fromId,
      redis,
      handler: async job => {
        await this.processJob(job, redis);
      },
    });
  }

  async startQueueWorker() {
    const { app, logger } = this.ctx;
    const workerConfig = app.config.transferQueue || {};
    const blockTimeoutSec = Number(workerConfig.readyQueueBlockTimeoutSec || 1);
    const errorSleepMs = Number(workerConfig.workerErrorSleepMs || 1000);

    // 建立獨立的 ioredis 直連，繞過 egg cluster-client IPC 延遲
    const redisConfig = app.config.redis && app.config.redis.client
      ? app.config.redis.client
      : { host: '127.0.0.1', port: 6379, db: 0 };

    const redis = new Redis({
      host: redisConfig.host || '127.0.0.1',
      port: redisConfig.port || 6379,
      password: redisConfig.password || undefined,
      db: redisConfig.db || 0,
    });

    redis.on('error', err => {
      logger.error('[QueueWorker] redis error: %s', err && err.message);
    });

    logger.info('[QueueWorker] direct redis connected');

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const fromId = await redisTransferQueue.blockPopReadyFromId(
          redis,
          blockTimeoutSec
        );

        if (!fromId) continue;

        // 不 await drain，讓 loop 立刻取下一個 fromId
        this.tryDrainOneFromIdQueue(fromId, redis).catch(err => {
          logger.error(
            '[QueueWorker] drain error: fromId=%s err=%s',
            fromId,
            err && (err.stack || err.message)
          );
        });
      } catch (err) {
        logger.error(
          '[QueueWorker] loop error: %s',
          err && (err.stack || err.message)
        );

        await new Promise(resolve => setTimeout(resolve, errorSleepMs));
      }
    }
  }

  async listTransfers({ accountId, limit }) {
    const aid = Number(accountId);
    const lim = limit === undefined ? 50 : Number(limit);

    if (!Number.isInteger(aid) || aid <= 0) {
      throw new BadRequestError('accountId must be a positive integer');
    }

    if (!Number.isInteger(lim) || lim <= 0) {
      throw new BadRequestError('limit must be a positive integer');
    }

    if (lim > 200) {
      throw new BadRequestError('limit must be <= 200');
    }

    const items = await this.repo.listByAccountId(aid, lim);

    return { items };
  }
}

module.exports = TransferService;
