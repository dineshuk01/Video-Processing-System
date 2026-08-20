import { Router, Request, Response, NextFunction } from 'express';
import { videoService } from '../services/video/videoService';
import { ResponseHandler } from '../utils/responseHandler';
import { adminAuthMiddleware } from '../middleware/auth';

const router = Router();

// 0. POST /api/admin/login — Validate admin password from .env
router.post(
  '/admin/login',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { password } = req.body;
      const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

      if (!password || password !== adminPassword) {
        return ResponseHandler.error(res, 'Incorrect admin password', 401, 'INVALID_PASSWORD');
      }

      return ResponseHandler.success(res, { message: 'Authentication successful', token: adminPassword }, 200);
    } catch (err: any) {
      next(err);
    }
  }
);

// 1. POST /api/upload/initiate (Protected)
router.post(
  '/initiate',
  adminAuthMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { filename, contentType, fileSize } = req.body;

      if (!filename || typeof filename !== 'string') {
        return ResponseHandler.error(res, 'Invalid or missing parameter: filename', 400);
      }
      if (!contentType || typeof contentType !== 'string') {
        return ResponseHandler.error(res, 'Invalid or missing parameter: contentType', 400);
      }
      if (fileSize === undefined || typeof fileSize !== 'number' || fileSize <= 0) {
        return ResponseHandler.error(res, 'Invalid or missing parameter: fileSize (must be a positive number)', 400);
      }

      const result = await videoService.initiateUpload({ filename, contentType, fileSize });
      return ResponseHandler.success(res, result, 201);
    } catch (err: any) {
      next(err);
    }
  }
);

// 2. POST /api/upload/complete (Protected)
router.post(
  '/complete',
  adminAuthMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { videoId } = req.body;

      if (!videoId || typeof videoId !== 'string') {
        return ResponseHandler.error(res, 'Invalid or missing parameter: videoId', 400);
      }

      const result = await videoService.completeUpload(videoId);
      return ResponseHandler.success(res, result, 200);
    } catch (err: any) {
      next(err);
    }
  }
);

// 3. GET /api/videos (with pagination) — Public
router.get(
  '/',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pageQuery = req.query.page;
      const limitQuery = req.query.limit;

      let page = parseInt(pageQuery as string, 10);
      let limit = parseInt(limitQuery as string, 10);

      if (isNaN(page) || page <= 0) page = 1;
      if (isNaN(limit) || limit <= 0) limit = 10;

      const result = await videoService.getVideos(page, limit);
      return ResponseHandler.success(res, result, 200);
    } catch (err: any) {
      next(err);
    }
  }
);

// 4. GET /api/videos/:id — fetch a single video record — Public
router.get(
  '/:id',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const video = await videoService.getVideo(id);
      if (!video) {
        return ResponseHandler.error(res, `Video with ID ${id} not found`, 404, 'NOT_FOUND');
      }
      return ResponseHandler.success(res, video, 200);
    } catch (err: any) {
      next(err);
    }
  }
);

// 5. DELETE /api/videos/:id — delete a video (Protected)
router.delete(
  '/:id',
  adminAuthMiddleware,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      await videoService.deleteVideo(id);
      return ResponseHandler.success(res, { message: 'Video deleted successfully' }, 200);
    } catch (err: any) {
      if (err.message.includes('not found')) {
        return ResponseHandler.error(res, err.message, 404, 'NOT_FOUND');
      }
      next(err);
    }
  }
);

export default router;
