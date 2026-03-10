'use strict';

// Router 設定
// 這裡定義所有 HTTP API endpoint，
// 並把 request 導向對應的 controller。

module.exports = app => {
  const { router, controller } = app;

  // =========================
  // 基本路由
  // =========================

  // 首頁
  router.get('/', controller.home.index);

  // 健康檢查
  // 用於監控系統是否正常運作
  router.get('/health', controller.health.index);


  // =========================
  // Users API
  // 使用者相關操作
  // =========================

  // 建立使用者
  router.post('/users', controller.users.create);

  // 查詢使用者
  router.get('/users/:id', controller.users.show);


  // =========================
  // Accounts API
  // 帳戶相關操作
  // =========================

  // 建立帳戶
  router.post('/accounts', controller.accounts.create);

  // 查詢帳戶餘額
  router.get('/accounts/:id', controller.accounts.show);


  // =========================
  // Transfers API
  // =========================
  //
  // Async Job API 架構說明
  //
  // POST /transfers
  //   → 建立 transfer job
  //   → job 會被放入 Redis queue
  //   → 立刻回傳 jobId
  //
  // GET /transfer-jobs/:jobId
  //   → 查詢 job 狀態
  //   → client 可透過輪詢取得最終結果
  //

  // 建立轉帳（只建立 job，不直接執行轉帳）
  router.post('/transfers', controller.transfers.create);

  // 查詢轉帳紀錄（歷史資料）
  router.get('/transfers', controller.transfers.list);


  // =========================
  // Transfer Jobs API
  // =========================
  //
  // 提供 Async Job API 的 job 狀態查詢
  //

  // 查詢 transfer job 狀態
  // client 可透過輪詢這個 API 取得最終轉帳結果
  router.get('/transfer-jobs/:jobId', controller.transferJobs.show);
};
