'use strict';

/**
 * @param {Egg.Application} app - egg application
 */
module.exports = app => {
  const { router, controller } = app;

  router.get('/', controller.home.index);
  router.get('/health', controller.health.index);

  // Users
  // 建立使用者
  router.post('/users', controller.users.create);
  // 查詢使用者
  router.get('/users/:id', controller.users.show);

  // Accounts
  // 建立帳戶
  router.post('/accounts', controller.accounts.create);
  // 查詢帳戶餘額
  router.get('/accounts/:id', controller.accounts.show);

  // Transfers
  // 建立轉帳
  router.post('/transfers', controller.transfers.create);
  // 查詢轉帳記錄
  router.get('/transfers', controller.transfers.list);
};
