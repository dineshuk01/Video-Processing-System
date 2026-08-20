import { Request, Response, NextFunction } from 'express';
import { ResponseHandler } from '../utils/responseHandler';

export function adminAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const providedPassword = req.headers['x-admin-password'] || req.headers['authorization']?.replace('Bearer ', '');

  if (!providedPassword || providedPassword !== adminPassword) {
    return ResponseHandler.error(
      res,
      'Unauthorized: Invalid or missing admin password',
      401,
      'UNAUTHORIZED'
    );
  }

  next();
}
