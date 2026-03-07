'use strict';

// account cache 的存活時間（秒）
const ACCOUNT_TTL_SECONDS = 30;

module.exports = {
  // 產生 account cache key
  // 例如 id=6 -> account:6
  accountKey(id) {
    return `account:${id}`;
  },

  // 取得 account cache TTL
  // 之後如果要統一修改快取時間，只改這裡就可以
  accountTTL() {
    return ACCOUNT_TTL_SECONDS;
  },

  // 把 Redis 取出的字串轉回 JSON
  // 如果資料不存在或 JSON 格式錯誤，就回傳 null
  parseJSON(value) {
    if (!value) return null;

    try {
      return JSON.parse(value);
    } catch (err) {
      return null;
    }
  },

  // 把物件轉成 JSON 字串，方便存進 Redis
  stringify(value) {
    return JSON.stringify(value);
  },
};
