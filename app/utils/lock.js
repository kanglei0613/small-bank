'use strict';

/**
 * @file app/utils/lock.js
 *
 * 輕量級 In-Process Mutex（KeyLock）
 *
 * 職責：
 * - withLock(key, fn)：確保同一 key 的非同步工作在 process 內串行執行，防止並發競態
 *
 * 設計說明：
 * - 以 Promise chain 實作，不依賴任何外部套件
 * - 適用於需要串行化的場景（如避免同一帳號同時寫入 Redis cache）
 * - 僅作用於單一 Node.js process；若有多 process / cluster，請改用 Redis lock
 * - 模組以 singleton 匯出（module.exports = new KeyLock()），全 app 共用同一個 lock 實例
 */

// 最簡單穩定版 mutex：同一 key 的工作會排隊串行
class KeyLock {
  constructor() {
    this.chains = new Map(); // key -> Promise
  }

  /**
   * 對指定 key 加鎖並串行執行 fn，執行完畢後自動釋放
   * @param {string} key - 鎖的識別 key（如 accountId）
   * @param {() => Promise<*>} fn - 需要串行化的非同步函數
   * @returns {Promise<*>} fn 的回傳值
   */
  async withLock(key, fn) {
    const prev = this.chains.get(key) || Promise.resolve();

    let release;
    const next = new Promise(resolve => (release = resolve));
    this.chains.set(key, prev.then(() => next));

    await prev;
    try {
      return await fn();
    } finally {
      release();
      // 清理：如果沒人接在後面就刪掉
      setTimeout(() => {
        if (this.chains.get(key) === next) this.chains.delete(key);
      }, 0);
    }
  }
}

module.exports = new KeyLock();
