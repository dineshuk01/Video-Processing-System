import express from 'express';
import cors from 'cors';
import * as dotenv from 'dotenv';
import { Server } from 'http';
import { Logger } from './utils/logger';
import { ResponseHandler } from './utils/responseHandler';
import uploadRouter from './routes/upload';
import localS3Router from './routes/localS3';

// Load environment variables
dotenv.config();

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

app.use(cors());
app.use(express.json());

// Health Check Endpoint
app.get('/health', (req: express.Request, res: express.Response) => {
  return res.status(200).json({
    status: 'OK',
    provider: process.env.PROVIDER,
    timestamp: new Date().toISOString(),
  });
});

// Register routes
app.use('/api/upload', uploadRouter);

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

    // Handle Express Body Parser Limit Errors
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

// 4. Start Server
const server: Server = app.listen(port, () => {
  Logger.info(`Video Processing API Server started successfully on port ${port}`, {
    provider: process.env.PROVIDER,
    nodeEnv: process.env.NODE_ENV,
  });
});

// Increase socket timeout to 10 minutes to support large file uploads
server.setTimeout(10 * 60 * 1000);

// 5. Graceful Shutdown
function handleGracefulShutdown(signal: string) {
  Logger.warn(`Received ${signal}. Starting graceful shutdown...`);

  server.close(() => {
    Logger.info('Express HTTP server closed.');
    Logger.info('Graceful shutdown completed. Exiting process.');
    process.exit(0);
  });

  // Force close after timeout (10 seconds)
  setTimeout(() => {
    Logger.error('Forced shutdown: Connections did not close in time.');
    process.exit(1);
  }, 10000);
}

process.on('SIGINT', () => handleGracefulShutdown('SIGINT'));
process.on('SIGTERM', () => handleGracefulShutdown('SIGTERM'));
