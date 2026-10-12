import { NextFunction, Request, Response, Router } from 'express';
import { videoService } from '../services/video/videoService';
import { ResponseHandler } from '../utils/responseHandler';

// The only API the public site uses. It can read published videos and nothing else:
// no uploads, deletes, jobs, queues, logs, errors or file sizes.
const router = Router();

router.get('/videos', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const videos = (await videoService.listPublished()).filter((v) => !q || v.title.toLowerCase().includes(q));
    res.setHeader('Cache-Control', 'public, max-age=10');
    return ResponseHandler.success(res, { videos: videos.slice(0, 500), total: videos.length });
  } catch (err) {
    next(err);
  }
});

// Published series (with all their published episodes, grouped by season)
router.get('/series', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const series = await videoService.listPublicSeries();
    res.setHeader('Cache-Control', 'public, max-age=10');
    return ResponseHandler.success(res, { series, total: series.length });
  } catch (err) {
    next(err);
  }
});

router.get('/series/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const series = await videoService.getPublicSeries(req.params.id);
    if (!series) return ResponseHandler.error(res, 'Series not found', 404, 'NOT_FOUND');
    res.setHeader('Cache-Control', 'public, max-age=10');
    return ResponseHandler.success(res, series);
  } catch (err) {
    next(err);
  }
});

router.get('/videos/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const video = await videoService.getPublished(req.params.id);
    // Unpublished, unfinished and missing videos all look the same from outside
    if (!video) return ResponseHandler.error(res, 'Video not found', 404, 'NOT_FOUND');
    res.setHeader('Cache-Control', 'public, max-age=10');
    return ResponseHandler.success(res, video);
  } catch (err) {
    next(err);
  }
});

export default router;
