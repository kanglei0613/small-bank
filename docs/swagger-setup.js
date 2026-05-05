'use strict';

/**
 * swagger-setup.js
 *
 * Mounts Swagger UI at /api-docs on the given Express/Egg app.
 *
 * Usage (in app.js or a custom Egg plugin):
 *
 *   const setupSwagger = require('./docs/swagger-setup');
 *   setupSwagger(app); // app is an express-compatible instance
 *
 * For Egg.js, mount in app.js beforeStart or via a middleware:
 *
 *   // app.js
 *   class AppBootHook {
 *     constructor(app) { this.app = app; }
 *     async serverDidReady() {
 *       const setupSwagger = require('./docs/swagger-setup');
 *       setupSwagger(this.app);
 *     }
 *   }
 *   module.exports = AppBootHook;
 *
 * Install dependencies first:
 *   npm install swagger-ui-express js-yaml --save
 */

const path = require('path');
const fs = require('fs');

function setupSwagger(app) {
  let swaggerUi, YAML;

  try {
    swaggerUi = require('swagger-ui-express');
    YAML = require('js-yaml');
  } catch (e) {
    console.warn('[swagger-setup] swagger-ui-express or js-yaml not installed. Skipping Swagger UI.');
    console.warn('[swagger-setup] Run: npm install swagger-ui-express js-yaml --save');
    return;
  }

  const specPath = path.join(__dirname, 'openapi.yaml');
  const swaggerDocument = YAML.load(fs.readFileSync(specPath, 'utf8'));

  const swaggerOptions = {
    swaggerOptions: {
      url: '/api-docs/swagger.json',
      // Disable "try it out" in production
      supportedSubmitMethods: process.env.NODE_ENV === 'production' ? [] : [ 'get', 'post', 'put', 'delete', 'patch' ],
    },
    customSiteTitle: 'Small Bank API Docs',
    customCss: '.swagger-ui .topbar { display: none }',
  };

  // Serve raw spec as JSON (useful for external tools)
  app.get('/api-docs/swagger.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(swaggerDocument, null, 2));
  });

  // Mount Swagger UI
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, swaggerOptions));

  console.log('[swagger-setup] Swagger UI available at http://localhost:7001/api-docs');
}

module.exports = setupSwagger;
