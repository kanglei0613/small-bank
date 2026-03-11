'use strict';

// Queue Worker
//
// 作用：
// - 背景 worker 定期掃描 Redis transfer queue
// - 如果某個 fromId queue 有 job
// - 嘗試取得 owner 並啟動 drain
//
// 這樣可以讓：
// - API worker 只負責 enqueue
// - Queue worker 專門處理 background transfer job
//
// 架構：
//
// Client
//   ↓
// API worker (enqueue)
//   ↓
// Redis queue
//   ↓
// Queue worker (schedule)
//   ↓
// processTransferJob
//   ↓
// PostgreSQL

const Subscription = require('egg').Subscription;
const redisTransferQueue = require('../lib/redis_transfer_queue');

class QueueWorker extends Subscription {

  // 每秒執行一次
  static get schedule() {
    return {
      interval: '1s',
      type: 'worker', // 每個 worker 都執行
    };
  }

  async subscribe() {

    const { app, ctx, logger } = this;

    const redis = app.redis;

    try {

      // 找出所有 transfer queue
      // transfer:queue:from:*
      const keys = await redis.keys('transfer:queue:from:*');

      if (!keys || keys.length === 0) {
        return;
      }

      logger.info(
        '[QueueWorker] scanning queues: count=%s',
        keys.length
      );

      for (const key of keys) {

        // key 範例
        // transfer:queue:from:6
        const parts = key.split(':');
        const fromId = Number(parts[parts.length - 1]);

        if (!Number.isInteger(fromId) || fromId <= 0) {
          continue;
        }

        try {

          await redisTransferQueue.tryStartDrain({
            ctx,
            fromId,
            handler: async job => {
              return await ctx.service.transfers.processTransferJob(job);
            },
          });

        } catch (err) {

          logger.error(
            '[QueueWorker] drain error: fromId=%s err=%s',
            fromId,
            err && err.message
          );

        }

      }

    } catch (err) {

      logger.error(
        '[QueueWorker] scan error: err=%s',
        err && err.message
      );

    }

  }

}

module.exports = QueueWorker;
