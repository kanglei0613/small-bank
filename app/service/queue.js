'use strict';

const Service = require('egg').Service;
const redisTransferQueue = require('../lib/queue/redis_transfer_queue');

const ACTIVE_FROM_IDS_KEY = 'transfer:queue:active:fromIds';

class QueueService extends Service {

  async getQueueStats(fromId) {
    const { app } = this.ctx;
    const queueConfig = app.config.transferQueue || {
      rejectThresholdPerFromId: 240,
      maxQueueLengthPerFromId: 300,
      ownerTtlMs: 10000,
      ownerRefreshIntervalMs: 3000,
      batchSize: 20,
    };

    return await redisTransferQueue.getQueueStats(app.redis, fromId, {
      rejectThresholdPerFromId: queueConfig.rejectThresholdPerFromId,
      maxQueueLengthPerFromId: queueConfig.maxQueueLengthPerFromId,
      ownerTtlMs: queueConfig.ownerTtlMs,
      ownerRefreshIntervalMs: queueConfig.ownerRefreshIntervalMs,
      batchSize: queueConfig.batchSize,
    });
  }

  async getGlobalStats() {
    const { app } = this.ctx;
    const { redis } = app;

    const fromIds = await redis.smembers(ACTIVE_FROM_IDS_KEY);

    let totalJobs = 0;
    const hotAccounts = [];

    for (const fromId of fromIds) {
      const queueKey = `transfer:queue:from:${fromId}`;
      const queueLength = await redis.llen(queueKey);

      totalJobs += queueLength;

      if (queueLength > 0) {
        hotAccounts.push({ fromId: Number(fromId), queueLength });
      }
    }

    hotAccounts.sort((a, b) => b.queueLength - a.queueLength);

    return {
      totalQueues: fromIds.length,
      totalJobs,
      hotAccounts,
      workers: app.config.cluster && app.config.cluster.workers || 1,
    };
  }
}

module.exports = QueueService;
