// obsolete
// 舊版 single-process queue 架構，不再用於主流程

'use strict';

/**
 * TransferQueueManager
 *
 * 作用：
 * 1. 依照 queue key（這裡會是 transfer:{fromId}）維護不同 queue
 * 2. 同一個 key 的 job 要依序執行
 * 3. 不同 key 的 job 可以並行執行
 */
class TransferQueueManager {
  constructor() {
    // queues: 存每個 key 對應的 job 陣列
    // 例如:
    // key = "transfer:6"
    // value = [job1, job2, job3]
    this.queues = new Map();

    // running: 記錄某個 key 目前是否已有 worker 在處理
    // key = "transfer:6"
    // value = true / false
    this.running = new Map();

    // 單一 queue 最多可堆多少 job
    // 避免某個熱門 fromId 無限堆積，把記憶體吃爆
    this.maxQueueLength = 1000;
  }


  // enqueue(key, handler, payload)
  //
  // 參數：
  // - key: queue key，例如 "transfer:6"
  // - handler: 真正執行工作的函式
  // - payload: 這筆 transfer 的資料，例如 { fromId, toId, amount }
  //
  // 回傳：
  // - Promise
  //   讓外部可以 await 這筆 job 的最終執行結果
  //
  async enqueue(key, handler, payload) {
    // 先取出這個 key 的 queue，如果沒有就建立空陣列
    const queue = this.queues.get(key) || [];

    // 如果 queue 已滿，直接拒絕
    if (queue.length >= this.maxQueueLength) {
      const err = new Error(`queue overflow for key=${key}`);
      err.status = 429;
      throw err;
    }

    // 回傳 Promise，這樣 controller / dispatcher 可以 await
    return await new Promise((resolve, reject) => {
      // 把這筆 job 放進 queue
      queue.push({
        payload, // transfer 資料
        handler, // 真正執行 transfer 的函式
        resolve, // 成功時要呼叫
        reject, // 失敗時要呼叫
        enqueuedAt: Date.now(), // 記錄進 queue 的時間，方便算等待時間
      });

      // 更新這個 key 對應的 queue
      this.queues.set(key, queue);

      // 如果這個 key 目前沒有 worker 在跑，就啟動 drain
      if (!this.running.get(key)) {
        this.running.set(key, true);

        // 啟動這個 key 的排隊處理流程
        this._drain(key).catch(err => {
          console.error(`[queue] drain fatal error, key=${key}`, err);
        });
      }
    });
  }

  //
  // _drain(key)
  //
  // 作用：
  // - 持續把該 key queue 裡的 job 一筆一筆拿出來執行
  // - 保證同 key 串行
  //
  async _drain(key) {
    const queue = this.queues.get(key);

    // 如果 queue 不存在或已經空了，就把狀態清掉
    if (!queue || queue.length === 0) {
      this.running.delete(key);
      this.queues.delete(key);
      return;
    }

    // 只要 queue 裡還有 job，就一直處理
    while (queue.length > 0) {
      // 拿出最前面那筆 job
      const job = queue.shift();

      try {
        // 算這筆 job 在 queue 裡等了多久
        const waitMs = Date.now() - job.enqueuedAt;

        console.log(
          `[queue] start key=${key}, waitMs=${waitMs}, remaining=${queue.length}`
        );

        // 執行真正的 transfer 邏輯
        const result = await job.handler(job.payload);

        // 成功就 resolve，讓上層拿到結果
        job.resolve(result);

        console.log(
          `[queue] finish key=${key}, remaining=${queue.length}`
        );
      } catch (err) {
        // 失敗就 reject，讓上層拿到錯誤
        job.reject(err);

        console.error(
          `[queue] failed key=${key}, remaining=${queue.length}, message=${err.message}`
        );
      }
    }

    // 這條 queue 全部清空後，把狀態移除
    this.running.delete(key);
    this.queues.delete(key);
  }

  //
  // 產生 queue key
  // 這裡統一集中，之後比較好改
  //
  buildTransferFromKey(fromId) {
    return `transfer:from:${fromId}`;
  }

  //
  // 取得某個 key 的 queue 長度
  //
  getQueueLength(key) {
    return (this.queues.get(key) || []).length;
  }

  /**
   * 取得整體 queue 統計資訊
   */
  getStats() {
    let totalQueued = 0;

    for (const queue of this.queues.values()) {
      totalQueued += queue.length;
    }

    return {
      activeKeys: this.queues.size, // 目前有幾個 queue key
      totalQueued, // 全部 queue 裡總共有多少 job
      runningKeys: this.running.size, // 目前有幾個 key 正在執行
    };
  }
}

// 匯出單例，整個 app 共用同一個 queue manager
module.exports = new TransferQueueManager();
