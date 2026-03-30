'use strict';

const Service = require('egg').Service;
const redisTransferQueue = require('../lib/queue/redis_transfer_queue');

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

    return await redisTransferQueue.getQueueStats(app.redis, fromId, queueConfig);
  }

  // Scan all active per-fromId queue keys to compute global stats.
  async getGlobalStats() {
    const { app } = this.ctx;
    const { redis } = app;

    // SCAN for all per-fromId queue keys (non-blocking, cursor-based)
    const queueKeys = [];
    let cursor = '0';
    do {
      const [ nextCursor, keys ] = await redis.scan(cursor, 'MATCH', 'transfer:queue:from:*', 'COUNT', 100);
      cursor = nextCursor;
      queueKeys.push(...keys);
    } while (cursor !== '0');

    let totalJobs = 0;
    const hotAccounts = [];

    for (const key of queueKeys) {
      const fromId = Number(key.replace('transfer:queue:from:', ''));
      const queueLength = await redis.llen(key);
      totalJobs += queueLength;
      if (queueLength > 0) {
        hotAccounts.push({ fromId, queueLength });
      }
    }

    hotAccounts.sort((a, b) => b.queueLength - a.queueLength);

    return {
      totalQueues: queueKeys.length,
      totalJobs,
      hotAccounts,
      workers: (app.config.cluster && app.config.cluster.workers) || 1,
    };
  }
}

module.exports = QueueService;
