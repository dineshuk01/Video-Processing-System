import { Router, Request, Response } from 'express';
import { getMetrics, getContentType } from '../services/metrics/metricsService';

const router = Router();

// GET /metrics — Prometheus metrics scraping endpoint
router.get('/', async (req: Request, res: Response) => {
  try {
    res.set('Content-Type', getContentType());
    const metrics = await getMetrics();
    res.send(metrics);
  } catch (err: any) {
    res.status(500).send(err.message);
  }
});

export default router;
