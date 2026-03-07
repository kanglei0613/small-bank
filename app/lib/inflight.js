'use strict';

// transfer inflight protection 的同時處理上限
// 代表同一個 fromId 最多只能有 1000000 個交易同時處理中
const TRANSFER_INFLIGHT_MAX = 1000000;

module.exports = {
  // 產生 transfer inflight counter 的 Redis key
  // 例如 fromId=6 -> inflight:transfer:from:6
  transferFromKey(fromId) {
    return `inflight:transfer:from:${fromId}`;
  },

  // 取得 transfer inflight 的最大同時處理數
  // 之後如果要改成 5 或 20，只要改這裡
  transferMaxInflight() {
    return TRANSFER_INFLIGHT_MAX;
  },
};
