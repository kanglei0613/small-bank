'use strict';

/**
 * @file app/lib/cache.js
 *
 * Redis Cache 工具模組
 *
 * 職責：
 * - accountKey：產生帳號快取 key（account:{id}）
 * - accountTTL：回傳帳號快取 TTL（30 秒），統一管理過期時間
 * - parseJSON：將 Redis 回傳的字串安全轉回 JS 物件，格式錯誤時回傳 null
 * - stringify：將物件轉成 JSON 字串以便存入 Redis
 *
 * 快取策略：
 * - 讀取時 cache hit 直接回傳；miss 則查 DB 並寫入 Redis
 * - 寫入（存款/提款）後主動清除對應 key，避免回傳過期餘額
 * - Redis 故障時靜默降級（catch 後繼續走 DB），不影響主流程
 */

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
