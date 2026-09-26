export class HttpError extends Error {
  constructor(status, code, message, detail = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }

  static notFound(code, message, detail) {
    return new HttpError(404, code, message, detail);
  }

  static badRequest(code, message, detail) {
    return new HttpError(400, code, message, detail);
  }
}
