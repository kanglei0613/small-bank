'use strict';

// Queue Worker (schedule) - DISABLED
//
// 此 schedule 已停用。
// Queue 處理改由獨立的 scripts/worker/queue_worker.js 負責。
//
// 原因：
// - 此版本呼叫 ctx.service.transfers.processTransferJob，該 function 已不存在
// - 獨立的 queue_worker.js 使用 BRPOP + owner lock，效能更好
// - 兩個 worker 同時跑會搶 job，造成錯誤

const Subscription = require('egg').Subscription;

class QueueWorker extends Subscription {

  static get schedule() {
    return {
      interval: '1h',
      type: 'worker',
      disable: true,
    };
  }

  async subscribe() {
    // disabled
  }

}

module.exports = QueueWorker;