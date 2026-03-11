'use strict';

const Service = require('egg').Service;
const redisTransferQueue = require('../lib/redis_transfer_queue');

class QueueService extends Service {

  //
  // 取得 queue stats
  //
  // 用於觀察某個 fromId queue 狀態
  //
  async getQueueStats(fromId) {

    const { app } = this.ctx;

    // 讀取 queue config
    const transferQueueConfig = app.config.transferQueue || {
      rejectThresholdPerFromId: 240,
      maxQueueLengthPerFromId: 300,
      ownerTtlMs: 10000,
      ownerRefreshIntervalMs: 3000,
      batchSize: 20,
    };

    // 基本檢查
    if (!Number.isInteger(fromId) || fromId <= 0) {
      const err = new Error('fromId must be positive integer');
      err.status = 400;
      throw err;
    }

    const stats = await redisTransferQueue.getQueueStats(
      app.redis,
      fromId,
      {
        rejectThresholdPerFromId: transferQueueConfig.rejectThresholdPerFromId,
        maxQueueLengthPerFromId: transferQueueConfig.maxQueueLengthPerFromId,
        ownerTtlMs: transferQueueConfig.ownerTtlMs,
        ownerRefreshIntervalMs: transferQueueConfig.ownerRefreshIntervalMs,
        batchSize: transferQueueConfig.batchSize,
      }
    );

    return stats;
  }


  //
  // 取得 global queue stats
  //
  // 用於觀察整體 queue 狀態
  //
  async getGlobalStats() {

    const { app } = this.ctx;

    const redis = app.redis;

    // 找出所有 transfer queue
    const pattern = 'transfer:queue:from:*';

    const keys = await redis.keys(pattern);

    let totalJobs = 0;

    const hotAccounts = [];

    for (const key of keys) {

      const queueLength = await redis.llen(key);

      totalJobs += queueLength;

      if (queueLength > 0) {

        const fromId = Number(key.split(':').pop());

        hotAccounts.push({
          fromId,
          queueLength,
        });

      }
    }

    // 依 queueLength 由大到小排序，方便觀察 hot account
    hotAccounts.sort((a, b) => b.queueLength - a.queueLength);

    return {
      totalQueues: keys.length,
      totalJobs,
      hotAccounts,
      workers: app.config.cluster?.workers || 1,
    };
  }

}

module.exports = QueueService;
