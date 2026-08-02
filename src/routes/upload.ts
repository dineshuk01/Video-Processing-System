import { Router, Request, Response, NextFunction } from 'express';
import { videoService } from '../services/video/videoService';
import { ResponseHandler } from '../utils/responseHandler';

const router = Router();

// 1. POST /api/upload/initiate
router.post(
  '/initiate',
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

// 2. POST /api/upload/complete
router.post(
  '/complete',
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

// 3. GET /api/videos (with pagination)
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

export default router;
