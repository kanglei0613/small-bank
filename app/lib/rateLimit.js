'use strict';

// transfer rate limit 的時間窗（秒）
// 代表在 1 秒內統計請求次數
const TRANSFER_WINDOW_SECONDS = 1;

// transfer rate limit 的次數上限
// 代表同一個 fromId 在 1 秒內最多可發出 1000000 次 transfer
const TRANSFER_MAX_REQUESTS = 1000000;

module.exports = {
  // 產生 transfer rate limit 的 Redis key
  // 例如 fromId=6 -> ratelimit:transfer:from:6
  transferFromKey(fromId) {
    return `ratelimit:transfer:from:${fromId}`;
  },

  // 取得 transfer rate limit 的時間窗（秒）
  // 之後如果要改成 2 秒或 5 秒，只要改這裡
  transferWindowSeconds() {
    return TRANSFER_WINDOW_SECONDS;
  },

  // 取得 transfer rate limit 的次數上限
  // 之後如果要改成每秒 10 次或 30 次，只要改這裡
  transferMaxRequests() {
    return TRANSFER_MAX_REQUESTS;
  },
};
