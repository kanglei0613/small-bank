'use strict';

/**
 * @param {Egg.Application} app - egg application
 */
module.exports = app => {
  const { router, controller } = app;

  router.get('/', controller.home.index);
  router.get('/health', controller.health.index);

  router.post('/users', controller.users.create);
  router.get('/users/:id', controller.users.show);

  router.post('/accounts', controller.accounts.create);
  router.get('/accounts/:id', controller.accounts.show);

  router.post('/transfers', controller.transfers.index);
};
