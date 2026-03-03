'use strict';

// 最簡單穩定版 mutex：同一 key 的工作會排隊串行
class KeyLock {
  constructor() {
    this.chains = new Map(); // key -> Promise
  }

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
