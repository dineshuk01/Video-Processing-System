import { Response } from 'express';

// Thrown by services so the error middleware can answer with the right HTTP status
export class HttpError extends Error {
  constructor(message: string, public status: number = 400, public code?: string) {
    super(message);
  }
}

export class ResponseHandler {
  static success(res: Response, data: any, statusCode: number = 200) {
    return res.status(statusCode).json({
      success: true,
      data,
    });
  }

  static error(
    res: Response,
    message: string,
    statusCode: number = 500,
    code?: string,
    details?: any
  ) {
    return res.status(statusCode).json({
      success: false,
      error: {
        message,
        code,
        details,
      },
    });
  }
}
