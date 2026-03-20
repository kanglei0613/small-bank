'use strict';

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
