'use strict';

// Router 設定
// 這裡定義所有 HTTP API endpoint，
// 並把 request 導向對應的 controller。

module.exports = app => {
  const { router, config } = app;
  const apiRole = config.apiRole || 'all';

  // =========================
  // 基本路由
  // =========================

  // 首頁
  router.get('/', 'home.index');

  // 健康檢查
  // 用於監控系統是否正常運作
  router.get('/health', 'health.index');


  // =========================
  // General API
  // =========================
  //
  // general API server 負責：
  // - Users API
  // - Accounts API
  // - transfer job 查詢
  // - transfer history 查詢
  // - queue 觀察 / debug API
  // - bench endpoints（非 /transfers）
  //
  // transfer API server 則只負責：
  // - POST /transfers
  //

  if (apiRole === 'all' || apiRole === 'general') {

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
    // 這裡只保留：
    // - 查詢轉帳紀錄（歷史資料）
    //
    // 真正建立轉帳的 POST /transfers
    // 會放在 transfer API server
    //

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

    // 存款 / 提款 API
    // 這兩條路徑不走 queue，直接做單帳戶 DB transaction，
    // 主要用於：
    // - 系統管理員操作（例如：補帳）
    // - 使用者操作（例如：線上儲值 / 提款到銀行帳戶）
    router.post('/accounts/:id/deposit', 'accounts.deposit');
    router.post('/accounts/:id/withdraw', 'accounts.withdraw');

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


    // =========================
    // Bench API
    // =========================
    //
    // 一般 bench endpoints
    //

    router.get('/bench/noop', 'bench.noop');
    router.post('/bench/redis-rpush', 'bench.redisRpush');
    router.post('/bench/redis-set-rpush', 'bench.redisSetRpush');
    router.post('/bench/redis-formal-push', 'bench.redisFormalPush');
    router.post('/bench/redis-formal-push-with-job', 'bench.redisFormalPushWithJob');
    router.post('/bench/transfers-enqueue-no-log', 'bench.transfersEnqueueNoLog');
    router.post('/bench/redis-pipeline-push', 'bench.redisPipelinePush');
    router.post('/bench/db-transfer', 'bench.dbTransfer');
  }


  // =========================
  // Transfer API
  // =========================
  //
  // Async Job API 架構說明
  //
  // POST /transfers
  //   → 建立 transfer job
  //   → job 會被放入 Redis queue
  //   → 立刻回傳 jobId
  //
  // 這條路徑獨立放到 transfer API server，
  // 避免與其他 read / CRUD API 互相搶 worker 資源。
  //

  if (apiRole === 'all' || apiRole === 'transfer') {

    // 建立轉帳（只建立 job，不直接執行轉帳）
    router.post('/transfers', 'transfers.submit');
  }

  router.get('/transfer-jobs/:jobId/stream', 'transferJobs.stream');
};
