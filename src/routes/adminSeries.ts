import { NextFunction, Request, Response, Router } from 'express';
import { seriesService, parseSeasonNumber } from '../services/series/seriesService';
import { videoService } from '../services/video/videoService';
import { clearPublishedCache } from '../services/video/publishedCache';
import { ResponseHandler } from '../utils/responseHandler';
import { summary } from '../utils/videoView';
import { imageBody } from '../middleware/imageBody';

// Admin-only: mounted at /api/admin/series behind requireAdmin
const router = Router();

// All series with episode counts
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const list = await seriesService.list();
    const data = await Promise.all(list.map(async (series) => {
      const episodes = await videoService.episodesForAdmin(series.id);
      return {
        ...series,
        episodeCount: episodes.length,
        liveEpisodes: episodes.filter((e) => videoService.isPublic(e)).length, // finished and published
        posterUrl: videoService.seriesPosterUrl(series, episodes),
      };
    }));
    return ResponseHandler.success(res, { series: data });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    return ResponseHandler.success(res, await seriesService.create({ title: req.body?.title, description: req.body?.description }), 201);
  } catch (err) {
    next(err);
  }
});

// One series with every episode (any status), in order
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const series = await seriesService.require(req.params.id);
    const episodes = await videoService.episodesForAdmin(series.id);
    return ResponseHandler.success(res, { series, episodes: episodes.map(summary) });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { title, description, published } = req.body || {};
    const series = await seriesService.update(req.params.id, { title, description, published });
    clearPublishedCache(); // every episode's visibility depends on this
    return ResponseHandler.success(res, series);
  } catch (err) {
    next(err);
  }
});

// ?deleteVideos=true also deletes the episode videos; otherwise they are kept as standalone drafts
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await videoService.deleteSeries(req.params.id, req.query.deleteVideos === 'true');
    return ResponseHandler.success(res, { message: 'Series deleted' });
  } catch (err) {
    next(err);
  }
});

// A custom poster for the series (otherwise the first episode's thumbnail is used)
router.post('/:id/poster', imageBody, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const series = await videoService.setSeriesPoster(req.params.id, req.body as Buffer);
    return ResponseHandler.success(res, { ...series, posterUrl: videoService.seriesPosterUrl(series, await videoService.episodesOf(series.id)) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/poster', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const series = await videoService.resetSeriesPoster(req.params.id);
    return ResponseHandler.success(res, { ...series, posterUrl: videoService.seriesPosterUrl(series, await videoService.episodesOf(series.id)) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/seasons', async (req: Request, res: Response, next: NextFunction) => {
  try {
    return ResponseHandler.success(res, await seriesService.addSeason(req.params.id, req.body?.number), 201);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/seasons/:number', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const season = parseSeasonNumber(req.params.number);
    const episodes = await videoService.episodesOf(req.params.id);
    return ResponseHandler.success(res, await seriesService.removeSeason(req.params.id, season, episodes.some((e) => e.seasonNumber === season)));
  } catch (err) {
    next(err);
  }
});

// Attach an existing video as an episode (or move/renumber it)
router.post('/:id/episodes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { videoId, seasonNumber, episodeNumber } = req.body || {};
    if (typeof videoId !== 'string' || !videoId) return ResponseHandler.error(res, 'videoId is required', 400, 'INVALID_BODY');
    const video = await videoService.assignEpisode(videoId, { seriesId: req.params.id, seasonNumber, episodeNumber });
    return ResponseHandler.success(res, summary(video));
  } catch (err) {
    next(err);
  }
});

export default router;
