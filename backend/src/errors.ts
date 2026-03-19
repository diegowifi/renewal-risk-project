export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'AppError';
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message: string, code = 'BAD_REQUEST'): AppError {
    return new AppError(400, message, code);
  }

  static notFound(message: string, code = 'NOT_FOUND'): AppError {
    return new AppError(404, message, code);
  }

  static conflict(message: string, code = 'CONFLICT'): AppError {
    return new AppError(409, message, code);
  }

  static internal(message: string, code = 'INTERNAL_SERVER_ERROR'): AppError {
    return new AppError(500, message, code);
  }
}
