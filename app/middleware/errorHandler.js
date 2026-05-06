'use strict';

/**
 * @file app/middleware/errorHandler.js
 *
 * 全域錯誤處理 Middleware（errorHandler）
 *
 * 職責：
 * - 攔截所有未捕獲的錯誤，依錯誤類型回傳對應的 HTTP status code 與訊息
 *
 * 錯誤分類處理邏輯：
 * 1. DB 連線錯誤（ECONNREFUSED 等 PG error codes）→ 503 service temporarily unavailable
 * 2. AppError（含 status 欄位）→ 使用 err.status 與 err.message 直接回傳
 * 3. 其他未知錯誤 → 500 internal server error，並寫入 error log
 */

const DB_CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  '57P01',
  '53300',
  '08000',
  '08003',
  '08006',
  '57P03',
]);

module.exports = () => {
  return async function errorHandler(ctx, next) {
    try {
      await next();
    } catch (err) {
      if (DB_CONNECTION_ERROR_CODES.has(err.code)) {
        ctx.status = 503;
        ctx.body = { ok: false, message: 'service temporarily unavailable' };
        return;
      }

      if (err.status) {
        ctx.status = err.status;
        ctx.body = { ok: false, message: err.message };
        return;
      }

      ctx.status = 500;
      ctx.body = { ok: false, message: 'internal server error' };
      ctx.app.logger.error('[errorHandler] unexpected error: %s', err.stack || err.message);
    }
  };
};
