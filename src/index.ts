import * as dotenv from 'dotenv';
// Load environment variables before any other imports
dotenv.config();

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { Server } from 'http';
import swaggerUi from 'swagger-ui-express';
import * as swaggerDocument from './docs/swagger.json';
import { Logger } from './utils/logger';
import { ResponseHandler } from './utils/responseHandler';
import * as path from 'path';
import uploadRouter from './routes/upload';
import localS3Router from './routes/localS3';
import eventsRouter from './routes/events';
import metricsRouter from './routes/metrics';
import adminRouter from './routes/admin';
import adminSeriesRouter from './routes/adminSeries';
import publicRouter from './routes/public';
import { adminAuthRouter, requireAdmin, warnIfAdminOpen } from './middleware/adminAuth';
import { publicLimiter } from './middleware/rateLimiter';
import { cleanupService } from './services/cleanup/cleanupService';

/**
 * Two applications share this backend:
 *   - user app  (/)       public streaming site; reads published videos through /api/public only
 *   - admin app (/admin)  private dashboard; every /api/admin route requires an admin sign-in
 * APP_MODE=all (default) serves both from one process. APP_MODE=user or APP_MODE=admin serves only
 * that application, so each can be deployed (and firewalled) on its own.
 */
type AppMode = 'all' | 'user' | 'admin';
const MODES: AppMode[] = ['all', 'user', 'admin'];

// 1. Validate Environment Variables
function validateEnv(): AppMode {
  const required = ['PORT', 'PROVIDER'];
  const missing: string[] = [];

  for (const key of required) {
    if (!process.env[key]) {
      missing.push(key);
    }
  }

  const mode = (process.env.APP_MODE || 'all') as AppMode;
  if (!MODES.includes(mode)) {
    throw new Error(`Invalid APP_MODE: "${mode}". Expected one of ${MODES.join(', ')}`);
  }

  const provider = process.env.PROVIDER;
  if (provider === 'local') {
    const localRequired = [
      'LOCAL_DATA_DIR',
      'LOCAL_S3_TEMP_BUCKET',
      'LOCAL_S3_PUBLIC_BUCKET',
      'LOCAL_SQS_QUEUE_NAME',
    ];
    for (const key of localRequired) {
      if (!process.env[key]) {
        missing.push(key);
      }
    }
  } else if (provider === 'aws') {
    const awsRequired = [
      'AWS_REGION',
      'AWS_S3_TEMP_BUCKET',
      'AWS_S3_PUBLIC_BUCKET',
      'AWS_SQS_QUEUE_URL',
    ];
    for (const key of awsRequired) {
      if (!process.env[key]) {
        missing.push(key);
      }
    }
  } else if (provider) {
    throw new Error(`Invalid PROVIDER: "${provider}". Expected "local" or "aws"`);
  }

  if (missing.length > 0) {
    Logger.error('Shutdown: Missing required environment variables', { missing });
    process.exit(1);
  }
  return mode;
}

let mode: AppMode;
try {
  mode = validateEnv();
} catch (err: any) {
  Logger.error('Environment validation failed', err.message);
  process.exit(1);
}
const serveUser = mode !== 'admin';
const serveAdmin = mode !== 'user';

// 2. Setup Express App
const app = express();
const port = parseInt(process.env.PORT || '5000', 10);
const webRoot = path.join(__dirname, '..', 'web');

// Security Headers (configured to allow inline video streaming & Hls.js cross-origin scripts)
app.use(
  helmet({
    contentSecurityPolicy: false, // Disabled CSP so CDN-loaded Hls.js can execute smoothly
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false, // Allow Hls.js to fetch video segments
  })
);

app.use(cors());
app.use(express.json());

// Liveness only. Anything about the system's internals lives behind the admin sign-in.
app.get('/health', (req: express.Request, res: express.Response) => {
  return res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// ─── Public side ─────────────────────────────────────────────
if (serveUser) {
  app.use('/api/public', publicLimiter, publicRouter);
}

// Media (HLS output, posters). The local stand-in for S3/CloudFront: the public can only read the
// output of published videos, while uploads and raw files need an admin (enforced in the router).
if (process.env.PROVIDER === 'local') {
  app.use('/api/local-s3', localS3Router);
  Logger.info('Mock S3 route mounted at /api/local-s3');
}

// ─── Admin side ──────────────────────────────────────────────
if (serveAdmin) {
  warnIfAdminOpen();
  app.use('/api/admin', adminAuthRouter);          // sign in / out / session (public by design)
  app.use('/api/admin', requireAdmin, adminRouter); // overview, queue, system, logs, publish, retry
  app.use('/api/admin/series', requireAdmin, adminSeriesRouter);
  app.use('/api/admin/upload', requireAdmin, uploadRouter);
  app.use('/api/admin/videos', requireAdmin, uploadRouter);
  app.use('/api/admin/events', requireAdmin, eventsRouter);
  app.use('/api/docs', requireAdmin, swaggerUi.serve, swaggerUi.setup(swaggerDocument));
  // Prometheus can't sign in, so scraping can be opened up explicitly (e.g. on a private network)
  app.use('/metrics', process.env.METRICS_PUBLIC === 'true' ? (_req, _res, next) => next() : requireAdmin, metricsRouter);
  Logger.info('Admin API mounted at /api/admin');
}

// ─── Front-end apps ──────────────────────────────────────────
app.use('/shared', express.static(path.join(webRoot, 'shared')));

if (serveAdmin) {
  // Never indexed or cached: it is a private tool
  app.use('/admin', (req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-store');
    next();
  }, express.static(path.join(webRoot, 'admin')));
}
if (serveUser) {
  app.use(express.static(path.join(webRoot, 'user')));
} else {
  app.get('/', (req, res) => res.redirect('/admin/'));
}

// Unknown API routes answer with JSON, not an HTML page
app.use('/api', (req, res) => ResponseHandler.error(res, 'Not found', 404, 'NOT_FOUND'));

// 3. Centralized Error-handling Middleware
app.use(
  (
    err: any,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    // Expected client errors (HttpError) are not worth a stack trace in the logs
    const status = err.status || 500;
    if (status >= 500) {
      Logger.error('Unhandled request error', {
        message: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method,
      });
    }

    if (err.type === 'entity.too.large') {
      return ResponseHandler.error(
        res,
        `Payload too large. Maximum file size limit is ${process.env.MAX_UPLOAD_SIZE_MB || 100}MB`,
        413,
        'PAYLOAD_TOO_LARGE'
      );
    }

    return ResponseHandler.error(
      res,
      status >= 500 && process.env.NODE_ENV === 'production' ? 'Internal Server Error' : (err.message || 'Internal Server Error'),
      status,
      err.code || (status >= 500 ? 'INTERNAL_ERROR' : undefined)
    );
  }
);

// 4. Start Periodic Cleanup Service (admin side owns storage housekeeping)
if (serveAdmin) cleanupService.startPeriodicCleanup();

// 5. Start Server
const server: Server = app.listen(port, () => {
  Logger.info(`Video Processing server started on port ${port} (APP_MODE=${mode})`, {
    provider: process.env.PROVIDER,
    nodeEnv: process.env.NODE_ENV,
    userApp: serveUser ? `http://localhost:${port}/` : 'off',
    adminApp: serveAdmin ? `http://localhost:${port}/admin/` : 'off',
  });
});

server.setTimeout(10 * 60 * 1000);

// 6. Graceful Shutdown
function handleGracefulShutdown(signal: string) {
  Logger.warn(`Received ${signal}. Starting graceful shutdown...`);

  server.close(() => {
    Logger.info('Express HTTP server closed.');
    Logger.info('Graceful shutdown completed. Exiting process.');
    process.exit(0);
  });

  setTimeout(() => {
    Logger.error('Forced shutdown: Connections did not close in time.');
    process.exit(1);
  }, 10000);
}

process.on('SIGINT', () => handleGracefulShutdown('SIGINT'));
process.on('SIGTERM', () => handleGracefulShutdown('SIGTERM'));
