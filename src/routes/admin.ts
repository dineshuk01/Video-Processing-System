import { NextFunction, Request, Response, Router } from 'express';
import { dbService } from '../services/db/dbService';
import { videoService } from '../services/video/videoService';
import { getQueueService } from '../services/queue/queueService';
import { getStorageService } from '../services/storage/storageService';
import { getComputeStatus } from '../services/compute/computeStatus';
import { ResponseHandler } from '../utils/responseHandler';
import { withoutEvents } from '../utils/videoView';
import { VideoStatus } from '../types';

// Everything here is mounted behind requireAdmin (see index.ts)
const router = Router();

const queueUrl = () =>
  process.env.PROVIDER === 'aws' ? process.env.AWS_SQS_QUEUE_URL! : process.env.LOCAL_SQS_QUEUE_NAME!;

async function queueStats() {
  try {
    return { available: true, ...(await getQueueService().getStats(queueUrl())) };
  } catch (err: any) {
    return { available: false, error: err.message, waiting: 0, inFlight: 0, delayed: 0 };
  }
}

// Dashboard summary
router.get('/overview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const all = await dbService.listAll();
    const count = (fn: (v: (typeof all)[number]) => boolean) => all.filter(fn).length;
    const day = Date.now() - 864e5;
    return ResponseHandler.success(res, {
      totals: {
        videos: all.length,
        published: count((v) => !!v.published && v.status === VideoStatus.COMPLETED),
        drafts: count((v) => v.status === VideoStatus.COMPLETED && !v.published),
        inProgress: count((v) => ['PENDING', 'UPLOADING', 'UPLOADED', 'PROCESSING'].includes(v.status)),
        paused: count((v) => v.status === VideoStatus.PAUSED),
        failed: count((v) => v.status === VideoStatus.FAILED),
        uploadedToday: count((v) => new Date(v.createdAt).getTime() >= day),
        storageBytes: all.reduce((sum, v) => sum + (v.fileSize || 0), 0),
      },
      retrying: count((v) => v.status !== VideoStatus.COMPLETED && v.status !== VideoStatus.FAILED && (v.attempts || 0) > 0 && !!v.error),
      queue: await queueStats(),
      compute: await getComputeStatus(),
    });
  } catch (err) {
    next(err);
  }
});

// Queue and processing engine
router.get('/queue', async (req: Request, res: Response, next: NextFunction) => {
  try {
    return ResponseHandler.success(res, { queue: await queueStats(), compute: await getComputeStatus() });
  } catch (err) {
    next(err);
  }
});

// Health of the pieces the app depends on, plus the settings an admin may want to see
router.get('/system', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const components: Record<string, string> = { api: 'UP', database: 'DOWN', storage: 'DOWN', queue: 'DOWN' };
    try { await dbService.listVideos(1, 1); components.database = 'UP'; } catch { /* stays DOWN */ }
    try {
      const bucket = process.env.PROVIDER === 'aws' ? process.env.AWS_S3_TEMP_BUCKET! : process.env.LOCAL_S3_TEMP_BUCKET!;
      await getStorageService().fileExists(bucket, 'health-probe-key');
      components.storage = 'UP';
    } catch { /* stays DOWN */ }
    const queue = await queueStats();
    if (queue.available) components.queue = 'UP';

    return ResponseHandler.success(res, {
      healthy: Object.values(components).every((s) => s === 'UP'),
      provider: process.env.PROVIDER,
      components,
      limits: {
        maxUploadMb: parseInt(process.env.MAX_UPLOAD_SIZE_MB || '1000', 10),
        allowedMimeTypes: (process.env.ALLOWED_MIME_TYPES || 'video/mp4,video/quicktime,video/x-matroska').split(','),
        maxAttempts: 3,
      },
      cdnEnabled: !!process.env.CDN_BASE_URL,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// Recent processing log lines across all videos, newest first
router.get('/logs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const level = typeof req.query.level === 'string' ? req.query.level : '';
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit || '200'), 10) || 200));

    const lines = (await dbService.listAll()).flatMap((v) =>
      (v.events || []).map((e) => ({
        ...e,
        videoId: v.id,
        videoName: v.title || v.originalName,
      }))
    )
      .filter((e) => (!level || e.level === level) && (!q || e.message.toLowerCase().includes(q) || e.videoName.toLowerCase().includes(q)))
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    return ResponseHandler.success(res, { total: lines.length, lines: lines.slice(0, limit) });
  } catch (err) {
    next(err);
  }
});

// One video's processing log
router.get('/videos/:id/logs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const video = await dbService.getVideo(req.params.id);
    if (!video) return ResponseHandler.error(res, `Video with ID ${req.params.id} not found`, 404, 'NOT_FOUND');
    return ResponseHandler.success(res, {
      id: video.id,
      status: video.status,
      attempts: video.attempts || 0,
      error: video.error,
      events: video.events || [],
    });
  } catch (err) {
    next(err);
  }
});

router.post('/videos/:id/publish', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (typeof req.body?.published !== 'boolean') {
      return ResponseHandler.error(res, 'published must be true or false', 400, 'INVALID_BODY');
    }
    const video = await videoService.setPublished(req.params.id, req.body.published);
    return ResponseHandler.success(res, withoutEvents(video));
  } catch (err) {
    next(err);
  }
});

router.patch('/videos/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { title, qualities, autoPublish, allowUpscale } = req.body || {};
    const video = await videoService.updateSettings(req.params.id, { title, qualities, autoPublish, allowUpscale });
    return ResponseHandler.success(res, withoutEvents(video));
  } catch (err) {
    next(err);
  }
});

// Attach a video to a series (or move / renumber it inside one)
router.post('/videos/:id/series', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { seriesId, seasonNumber, episodeNumber } = req.body || {};
    return ResponseHandler.success(res, withoutEvents(await videoService.assignEpisode(req.params.id, { seriesId, seasonNumber, episodeNumber })));
  } catch (err) {
    next(err);
  }
});

// Take a video out of its series; it becomes a standalone draft
router.delete('/videos/:id/series', async (req: Request, res: Response, next: NextFunction) => {
  try {
    return ResponseHandler.success(res, withoutEvents(await videoService.detachEpisode(req.params.id)));
  } catch (err) {
    next(err);
  }
});

router.post('/videos/:id/pause', async (req: Request, res: Response, next: NextFunction) => {
  try {
    return ResponseHandler.success(res, withoutEvents(await videoService.pauseVideo(req.params.id)));
  } catch (err) {
    next(err);
  }
});

// Resume a paused video: processing starts again from the beginning
router.post('/videos/:id/resume', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const video = await dbService.getVideo(req.params.id);
    if (video && video.status !== VideoStatus.PAUSED) {
      return ResponseHandler.error(res, 'Only paused videos can be resumed', 409, 'NOT_PAUSED');
    }
    return ResponseHandler.success(res, withoutEvents(await videoService.retryVideo(req.params.id, { qualities: req.body?.qualities })));
  } catch (err) {
    next(err);
  }
});

// Delete only the processed output; the original upload stays so it can be processed again
router.post('/videos/:id/delete-processed', async (req: Request, res: Response, next: NextFunction) => {
  try {
    return ResponseHandler.success(res, withoutEvents(await videoService.deleteProcessed(req.params.id)));
  } catch (err) {
    next(err);
  }
});

router.post('/videos/:id/retry', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const video = await videoService.retryVideo(req.params.id, { qualities: req.body?.qualities });
    return ResponseHandler.success(res, withoutEvents(video));
  } catch (err) {
    next(err);
  }
});

export default router;
