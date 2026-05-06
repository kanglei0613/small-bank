'use strict';

/**
 * @file app/service/queue.js
 *
 * Queue 狀態查詢層（QueueService）
 *
 * 職責：
 * - getQueueStats：查詢單一 fromId 的 queue 長度、owner lock 狀態、ready queue 長度等
 * - getGlobalStats：SCAN 所有 per-fromId queue key，彙整整體 queue 總量與 hot account 排行
 *
 * 注意：
 * - getGlobalStats 使用 cursor-based SCAN（非阻塞），但在 key 數量極大時仍有延遲
 * - 此 Service 為唯讀查詢，不寫入任何 Redis 或 DB 狀態
 */

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
