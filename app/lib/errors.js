'use strict';

/**
 * @file app/lib/errors.js
 *
 * 自定義應用程式錯誤類別
 *
 * 每個錯誤類別帶有固定的 HTTP status code，由 errorHandler middleware 統一攔截並回傳：
 * - AppError（基底）：帶 status 欄位，可被 errorHandler 識別
 * - BadRequestError (400)：請求參數錯誤，如缺少必要欄位、格式不合法
 * - NotFoundError (404)：資源不存在，如帳號或用戶查無資料
 * - ConflictError (409)：業務衝突，如餘額不足、重複操作
 * - TooManyRequestsError (429)：超過流量限制，如 queue 已滿
 * - InternalError (500)：內部錯誤，如 Saga 補償失敗、DB 狀態異常
 */

class AppError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

class BadRequestError extends AppError {
  constructor(message) { super(message, 400); }
}

class NotFoundError extends AppError {
  constructor(message) { super(message, 404); }
}

class ConflictError extends AppError {
  constructor(message) { super(message, 409); }
}

class TooManyRequestsError extends AppError {
  constructor(message) { super(message, 429); }
}

class InternalError extends AppError {
  constructor(message) { super(message, 500); }
}

module.exports = {
  AppError,
  BadRequestError,
  NotFoundError,
  ConflictError,
  TooManyRequestsError,
  InternalError,
};
