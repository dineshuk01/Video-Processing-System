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
import { apiLimiter, uploadLimiter } from './middleware/rateLimiter';
import { cleanupService } from './services/cleanup/cleanupService';
import { dbService } from './services/db/dbService';
import { getStorageService } from './services/storage/storageService';
import { getQueueService } from './services/queue/queueService';

// 1. Validate Environment Variables
function validateEnv() {
  const required = ['PORT', 'PROVIDER'];
  const missing: string[] = [];

  for (const key of required) {
    if (!process.env[key]) {
      missing.push(key);
    }
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
}

try {
  validateEnv();
} catch (err: any) {
  Logger.error('Environment validation failed', err.message);
  process.exit(1);
}

// 2. Setup Express App
const app = express();
const port = parseInt(process.env.PORT || '5000', 10);

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

// Apply rate limiter to REST API routes (excluding local S3 media streaming)
app.use('/api/upload', apiLimiter);
app.use('/api/videos', apiLimiter);

// Health Check Endpoint
app.get('/health', (req: express.Request, res: express.Response) => {
  return res.status(200).json({
    status: 'OK',
    provider: process.env.PROVIDER,
    timestamp: new Date().toISOString(),
  });
});

// Public client settings, so the UI shows the same upload limit the server enforces
app.get('/api/config', (req: express.Request, res: express.Response) => {
  return res.status(200).json({
    success: true,
    data: {
      maxUploadMb: parseInt(process.env.MAX_UPLOAD_SIZE_MB || '1000', 10),
      allowedMimeTypes: (process.env.ALLOWED_MIME_TYPES || 'video/mp4,video/quicktime,video/x-matroska')
        .split(',')
        .map((m) => m.trim()),
    },
  });
});

// Detailed Health Check Endpoint (Verifies DB, Storage, Queue connectivity)
app.get('/health/detailed', async (req: express.Request, res: express.Response) => {
  const status: Record<string, string> = {
    api: 'UP',
    database: 'UNKNOWN',
    storage: 'UNKNOWN',
    queue: 'UNKNOWN',
  };

  let healthy = true;

  try {
    await dbService.listVideos(1, 1);
    status.database = 'UP';
  } catch (err) {
    status.database = 'DOWN';
    healthy = false;
  }

  try {
    const storage = getStorageService();
    const bucket = process.env.PROVIDER === 'aws' ? process.env.AWS_S3_TEMP_BUCKET! : process.env.LOCAL_S3_TEMP_BUCKET!;
    await storage.fileExists(bucket, 'non-existent-probe-key');
    status.storage = 'UP';
  } catch (err) {
    status.storage = 'DOWN';
    healthy = false;
  }

  try {
    const queue = getQueueService();
    const queueUrl = process.env.PROVIDER === 'aws' ? process.env.AWS_SQS_QUEUE_URL! : process.env.LOCAL_SQS_QUEUE_NAME!;
    // Simple check that queue instance resolves
    if (queue) status.queue = 'UP';
  } catch (err) {
    status.queue = 'DOWN';
    healthy = false;
  }

  return res.status(healthy ? 200 : 503).json({
    status: healthy ? 'HEALTHY' : 'DEGRADED',
    components: status,
    timestamp: new Date().toISOString(),
  });
});

// Serve static frontend from public/ directory
app.use(express.static(path.join(__dirname, '..', 'public')));

// Register API Documentation route
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
Logger.info('API Documentation mounted at /api/docs');

// Register routes
app.use('/api/upload/initiate', uploadLimiter); // Apply strict upload rate limiter
app.use('/api/upload', uploadRouter);
app.use('/api/videos', uploadRouter);
app.use('/api/events', eventsRouter);
app.use('/metrics', metricsRouter);

// Register Local S3 mock router only in local mode
if (process.env.PROVIDER === 'local') {
  app.use('/api/local-s3', localS3Router);
  Logger.info('Mock S3 PUT route mounted at /api/local-s3');
}

// 3. Centralized Error-handling Middleware
app.use(
  (
    err: any,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    Logger.error('Unhandled request error', {
      message: err.message,
      stack: err.stack,
      path: req.path,
      method: req.method,
    });

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
      err.message || 'Internal Server Error',
      err.status || 500,
      err.code || 'INTERNAL_ERROR'
    );
  }
);

// 4. Start Periodic Cleanup Service
cleanupService.startPeriodicCleanup();

// 5. Start Server
const server: Server = app.listen(port, () => {
  Logger.info(`Video Processing API Server started successfully on port ${port}`, {
    provider: process.env.PROVIDER,
    nodeEnv: process.env.NODE_ENV,
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
