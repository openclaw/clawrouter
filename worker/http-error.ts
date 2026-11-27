export class HttpError extends Error {
  status: number;
  code: string;
  // Protocol response headers only (for example Retry-After); never secrets.
  headers?: Record<string, string>;
  constructor(status: number, code: string, message: string, headers?: Record<string, string>) { super(message); this.status = status; this.code = code; if (headers) this.headers = headers; }
}
