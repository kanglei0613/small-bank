'use strict';

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
