// 应用层通用错误载体：app.js 的错误中间件按 status / code / details 输出统一错误体。
export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
