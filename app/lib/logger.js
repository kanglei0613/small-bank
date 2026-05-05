'use strict';

/**
 * app/lib/logger.js
 *
 * Structured JSON logger wrapping Winston.
 * Supports requestId propagation via AsyncLocalStorage.
 *
 * Install dependency:
 *   npm install winston --save
 *
 * Usage:
 *   const logger = require('./logger');
 *   logger.info('message', { key: 'value' });
 *   logger.error('failed', { requestId: ctx.requestId, err: err.message });
 *
 * For Egg.js ctx.logger is the built-in logger — this module is for
 * standalone structured logs (e.g. in lib/queue, repo, or worker files)
 * that live outside the request lifecycle but still need requestId.
 */

const { createLogger, format, transports } = require('winston');
const { AsyncLocalStorage } = require('async_hooks');

// ---------------------------------------------------------------------------
// AsyncLocalStorage store — holds { requestId } for the current async context
// ---------------------------------------------------------------------------
const als = new AsyncLocalStorage();

/**
 * Run fn inside a new context with the provided store.
 * Call this in the requestId middleware so every downstream async call
 * in the same request automatically has access to the requestId.
 *
 * @param {object} store  e.g. { requestId: 'abc-123' }
 * @param {Function} fn
 */
function runWithStore(store, fn) {
  return als.run(store, fn);
}

/**
 * Get the current requestId from the async context.
 * Returns undefined outside a request context (e.g. queue workers).
 */
function getCurrentRequestId() {
  const store = als.getStore();
  return store && store.requestId;
}

// ---------------------------------------------------------------------------
// Custom format: inject requestId from ALS into every log record
// ---------------------------------------------------------------------------
const injectRequestId = format(info => {
  const requestId = getCurrentRequestId();
  if (requestId) {
    info.requestId = requestId;
  }
  return info;
});

// ---------------------------------------------------------------------------
// Winston logger instance
// ---------------------------------------------------------------------------
const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',

  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
    injectRequestId(),
    format.errors({ stack: true }),   // include err.stack if present
    format.json()                      // output as JSON line
  ),

  defaultMeta: {
    service: 'small-bank',
    env: process.env.NODE_ENV || 'development',
  },

  transports: [
    // Human-readable in dev; pure JSON in production (piped to log aggregator)
    process.env.NODE_ENV === 'production'
      ? new transports.Console()
      : new transports.Console({
        format: format.combine(
          format.colorize(),
          format.printf(({ timestamp, level, message, requestId, ...meta }) => {
            const rid = requestId ? ` [${requestId}]` : '';
            const extra = Object.keys(meta).length
              ? ' ' + JSON.stringify(meta)
              : '';
            return `${timestamp} ${level}${rid}: ${message}${extra}`;
          })
        ),
      }),
  ],
});

// ---------------------------------------------------------------------------
// File transport in production (optional — enabled via LOG_TO_FILE=1)
// ---------------------------------------------------------------------------
if (process.env.LOG_TO_FILE === '1') {
  logger.add(new transports.File({
    filename: process.env.LOG_FILE_PATH || 'logs/app.log',
    maxsize: 50 * 1024 * 1024,   // 50 MB
    maxFiles: 5,
    tailable: true,
  }));
}

module.exports = {
  logger,
  runWithStore,
  getCurrentRequestId,
};
