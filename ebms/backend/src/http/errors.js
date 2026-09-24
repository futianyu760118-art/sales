'use strict';

class AppError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (code, message, details) => new AppError(400, code, message, details);
const notFound = (code, message) => new AppError(404, code, message);
const conflict = (code, message) => new AppError(409, code, message);
const unauthorized = (code, message) => new AppError(401, code, message);

module.exports = { AppError, badRequest, notFound, conflict, unauthorized };
