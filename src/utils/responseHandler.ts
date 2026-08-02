import { Response } from 'express';

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
