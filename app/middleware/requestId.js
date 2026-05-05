'use strict';

/**
 * app/middleware/requestId.js
 *
 * Egg.js middleware that:
 *   1. Reads X-Request-Id from incoming request headers (for propagation
 *      from a gateway/load-balancer), or generates a new one.
 *   2. Attaches requestId to ctx so controllers/services can access it.
 *   3. Echoes it back in the X-Request-Id response header.
 *   4. Runs the rest of the request inside an AsyncLocalStorage context
 *      so logger.js can pick up the requestId without explicit passing.
 *
 * Registration in config/config.default.js:
 *   config.middleware = ['requestId', 'errorHandler'];
 *
 * No config options required. Optionally:
 *   config.requestId = { header: 'X-Request-Id' };   // custom header name
 */

const { randomUUID } = require('crypto');
const { runWithStore } = require('../lib/logger');

module.exports = (options = {}) => {
  const headerName = (options.header || 'X-Request-Id').toLowerCase();

  return async function requestIdMiddleware(ctx, next) {
    // Accept an upstream-provided ID or generate a fresh UUID v4
    const requestId = ctx.get(headerName) || randomUUID();

    // Attach to ctx for controllers / services
    ctx.requestId = requestId;

    // Echo back in response header
    ctx.set('X-Request-Id', requestId);

    // Run the rest of the pipeline inside the ALS context
    // so logger.js automatically picks up the requestId
    await runWithStore({ requestId }, () => next());
  };
};
