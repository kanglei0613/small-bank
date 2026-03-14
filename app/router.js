'use strict';

// Router 設定
// 這裡定義所有 HTTP API endpoint，
// 並把 request 導向對應的 controller。

module.exports = app => {
  const { router } = app;

  // =========================
  // 基本路由
  // =========================

  // 首頁
  router.get('/', 'home.index');

  // 健康檢查
  // 用於監控系統是否正常運作
  router.get('/health', 'health.index');


  // =========================
  // Users API
  // 使用者相關操作
  // =========================

  // 建立使用者
  router.post('/users', 'users.create');

  // 查詢使用者
  router.get('/users/:id', 'users.show');


  // =========================
  // Accounts API
  // 帳戶相關操作
  // =========================

  // 建立帳戶
  router.post('/accounts', 'accounts.create');

  // 查詢帳戶餘額
  router.get('/accounts/:id', 'accounts.show');


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
  router.post('/transfers', 'transfers.create');

  // 查詢轉帳紀錄（歷史資料）
  router.get('/transfers', 'transfers.list');


  // =========================
  // Transfer Jobs API
  // =========================
  //
  // 提供 Async Job API 的 job 狀態查詢
  //

  // 查詢 transfer job 狀態
  // client 可透過輪詢這個 API 取得最終轉帳結果
  router.get('/transfer-jobs/:jobId', 'transferJobs.show');


  // =========================
  // Queue API
  // =========================
  //
  // 用於觀察 Redis transfer queue 狀態
  // 主要用於：
  // - Debug
  // - 系統監控
  // - Hot account 偵測
  //

  // 查詢某個 fromId queue 狀態
  router.get('/queue/stats', 'queue.stats');

  // 查詢整體 queue metrics
  router.get('/queue/global-stats', 'queue.globalStats');

};
