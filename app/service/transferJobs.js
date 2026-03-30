'use strict';

const Redis = require('ioredis'); // 引入 Redis 套件
const { PassThrough } = require('stream'); // 引用串流套件以實作 SSE
const Service = require('egg').Service; // 繼承 Egg.js 的 service 資料
const transferJobStore = require('../lib/queue/transfer_job_store'); // 操作 Job 狀態的工具
const { BadRequestError, NotFoundError } = require('../lib/errors'); // 自定義錯誤類型

class TransferJobsService extends Service {

  // getJobById(jobId)
  //
  // 作用：
  // - 根據 jobId 從 Redis 讀取 transfer job 狀態
  // - 回傳 job 的完整資訊
  async getJobById(jobId) {
    const { app } = this.ctx;

    // 確保 jobId 存在且為字串
    if (!jobId || typeof jobId !== 'string') {
      throw new BadRequestError('jobId is required');
    }

    const redis = app.redisDb || app.redis; // 優先使用 app.redisDb ，否則用預設的 app.redis
    const job = await transferJobStore.getJob(redis, jobId); // 從 Redis 中取得 Job 詳情

    // 若查無任務，回傳錯誤
    if (!job) {
      throw new NotFoundError('transfer job not found');
    }

    return job; // 回傳 JSON 格式的 Job 狀態
  }

  // streamJobById(jobId)
  //
  // 作用：
  // - 若 job 已完成，直接回傳 JSON，不建立 SSE 連線
  // - 若 job 尚未完成，建立 SSE 連線，透過 Redis Pub/Sub 等待完成通知
  // - 完成後立即推送給前端並關閉連線
  //
  // 注意：
  // - 每個請求建立獨立的 ioredis subscriber 連線，避免共享 app.redisSub
  //   造成 unsubscribe 互相干擾的競態問題
  // - 訂閱後需再查一次 job 狀態，避免訂閱前 job 剛好完成導致漏掉通知
  // - 前端斷線或完成時 quit() 獨立連線，不影響其他請求
  async streamJobById(jobId) {
    const { app, ctx } = this;

    if (!jobId || typeof jobId !== 'string') {
      throw new BadRequestError('jobId is required');
    }

    const redis = app.redisDb || app.redis;
    const job = await transferJobStore.getJob(redis, jobId);

    if (!job) {
      throw new NotFoundError('transfer job not found');
    }

    // job 已完成，直接回傳，不需要 SSE
    if (job.status === 'success' || job.status === 'failed') {
      ctx.body = { ok: true, data: job };
      return;
    }

    // 設定 SSE headers
    ctx.set('Content-Type', 'text/event-stream'); // 告訴瀏覽器這是串流資料
    ctx.set('Cache-Control', 'no-cache'); // 禁用 cache ，保證資料即時正確
    ctx.set('Connection', 'keep-alive'); // 保持連線
    ctx.set('X-Accel-Buffering', 'no'); // 禁用代理伺服器的緩衝
    ctx.status = 200;

    const stream = new PassThrough(); // 建立直通串流
    ctx.body = stream; // 將串流綁到 Response body

    // 取得 Redis 設定
    const redisConfig = app.config.redis && app.config.redis.client
      ? app.config.redis.client
      : { host: '127.0.0.1', port: 6379, db: 0 };

    // 建立獨立的 ioredis subscriber 連線，繞過共享 app.redisSub 的競態問題
    // 連線設定沿用 app.redis.client，確保連到同一台 Redis
    const sub = new Redis({
      host: redisConfig.host || '127.0.0.1',
      port: redisConfig.port || 6379,
      password: redisConfig.password || undefined,
      db: redisConfig.db || 0,
    });

    const channel = `transfer:job:done:${jobId}`; // 定義監聽的頻道
    let cleaned = false; // 標記是否清理
    let timer; // 超時計時器

    // 定義送資料給前端的方法
    const send = data => {
      if (!stream.writableEnded) {
        stream.write(`data: ${JSON.stringify(data)}\n\n`); // SSE 標準格式
        stream.end(); // 推送完畢後關閉串流
      }
    };

    // 斷開 Redis 和清除計時器
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      ctx.logger.info('[TransferJobsService] cleanup called: jobId=%s stack=%s', jobId, new Error().stack.split('\n')[2].trim());
      clearTimeout(timer);
      sub.quit().catch(() => {}); // 退出 Redis 連線
    };

    // 監聽 Redis 訊息
    sub.on('message', (ch, message) => {
      if (ch !== channel) return;
      try {
        send(JSON.parse(message)); // 收到通知，發給前端
      } catch (err) {
        this.ctx.logger.error('[TransferJobsService] message parse error: jobId=%s err=%s', jobId, err && err.message);
        send({ status: 'failed', error: { message: 'parse error' } });
      }
      cleanup(); // 完成後清理
    });

    // sub 連線異常時推送 timeout，讓前端 fallback 輪詢
    sub.on('error', err => {
      process.stderr.write('[sub error] jobId=' + jobId + ' err=' + (err && err.message) + '\n');
      send({ status: 'timeout' });
      cleanup();
    });

    await sub.subscribe(channel); // 訂閱頻道

    // 訂閱後再查一次，避免訂閱期間 job 剛好完成導致漏掉通知
    const latestJob = await transferJobStore.getJob(redis, jobId);

    if (latestJob && (latestJob.status === 'success' || latestJob.status === 'failed')) {
      send(latestJob); // 如果發現已經做完了，立即推送和清理
      cleanup();
      return;
    }

    // 30 秒 timeout，避免連線永久佔用
    timer = setTimeout(() => {
      send({ status: 'timeout' });
      cleanup();
    }, 30000);

    // 前端斷線時清理資源
    ctx.req.on('close', cleanup);
  }
}

module.exports = TransferJobsService;
