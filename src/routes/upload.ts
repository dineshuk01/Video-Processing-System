import { Router, Request, Response, NextFunction } from 'express';
import { videoService } from '../services/video/videoService';
import { ResponseHandler } from '../utils/responseHandler';
import { summary } from '../utils/videoView';

// Admin-only: mounted at /api/admin/upload and /api/admin/videos behind requireAdmin
const router = Router();

// 1. POST /initiate
router.post(
  '/initiate',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { filename, contentType, fileSize, title, qualities, autoPublish, allowUpscale, seriesId, seasonNumber, episodeNumber } = req.body;

      if (!filename || typeof filename !== 'string') {
        return ResponseHandler.error(res, 'Invalid or missing parameter: filename', 400);
      }
      if (!contentType || typeof contentType !== 'string') {
        return ResponseHandler.error(res, 'Invalid or missing parameter: contentType', 400);
      }
      if (fileSize === undefined || typeof fileSize !== 'number' || fileSize <= 0) {
        return ResponseHandler.error(res, 'Invalid or missing parameter: fileSize (must be a positive number)', 400);
      }

      const result = await videoService.initiateUpload({ filename, contentType, fileSize, title, qualities, autoPublish, allowUpscale, seriesId, seasonNumber, episodeNumber });
      return ResponseHandler.success(res, result, 201);
    } catch (err: any) {
      next(err);
    }
  }
);

// 2. POST /complete
router.post(
  '/complete',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { videoId } = req.body;

      if (!videoId || typeof videoId !== 'string') {
        return ResponseHandler.error(res, 'Invalid or missing parameter: videoId', 400);
      }

      const result = await videoService.completeUpload(videoId);
      return ResponseHandler.success(res, summary(result), 200);
    } catch (err: any) {
      next(err);
    }
  }
);

// 3. GET /api/admin/videos (with pagination)
router.get(
  '/',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      let page = parseInt(req.query.page as string, 10);
      let limit = parseInt(req.query.limit as string, 10);

      if (isNaN(page) || page <= 0) page = 1;
      if (isNaN(limit) || limit <= 0) limit = 10;
      limit = Math.min(limit, 200);

      const result = await videoService.getVideos(page, limit);
      return ResponseHandler.success(res, { ...result, videos: result.videos.map(summary) }, 200);
    } catch (err: any) {
      next(err);
    }
  }
);

// 4. GET /api/admin/videos/:id — one video, including its processing log
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

// 5. DELETE /api/admin/videos/:id — delete a video and its resources
router.delete(
  '/:id',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await videoService.deleteVideo(req.params.id);
      return ResponseHandler.success(res, { message: 'Video deleted successfully' }, 200);
    } catch (err: any) {
      next(err);
    }
  }
);

export default router;
