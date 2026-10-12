import * as dotenv from 'dotenv';
import { getQueueService } from './services/queue/queueService';
import { jobProcessor } from './services/video/jobProcessor';
import { Logger } from './utils/logger';

// Load environment variables
dotenv.config();

let running = true;
let activeJobs = 0;

// How many videos are processed at the same time. On AWS each job just starts an ECS task and waits for it,
// so several can run side by side; locally every job uses this computer's CPU, so the default is one.
const concurrency = Math.min(10, Math.max(1, parseInt(process.env.WORKER_CONCURRENCY || '', 10) || 1));

// 1. Validate Environment Variables
function validateEnv() {
  const required = ['PROVIDER'];
  const missing: string[] = [];

  for (const key of required) {
    if (!process.env[key]) {
      missing.push(key);
    }
  }

  const provider = process.env.PROVIDER;
  if (provider === 'local') {
    const localRequired = ['LOCAL_DATA_DIR', 'LOCAL_SQS_QUEUE_NAME'];
    for (const key of localRequired) {
      if (!process.env[key]) {
        missing.push(key);
      }
    }
  } else if (provider === 'aws') {
    const awsRequired = ['AWS_REGION', 'AWS_SQS_QUEUE_URL'];
    for (const key of awsRequired) {
      if (!process.env[key]) {
        missing.push(key);
      }
    }
  } else if (provider) {
    throw new Error(`Invalid PROVIDER: "${provider}". Expected "local" or "aws"`);
  }

  if (missing.length > 0) {
    Logger.error('Worker Shutdown: Missing required environment variables', { missing });
    process.exit(1);
  }
}

try {
  validateEnv();
} catch (err: any) {
  Logger.error('Worker environment validation failed', err.message);
  process.exit(1);
}

const queueUrl =
  process.env.PROVIDER === 'aws'
    ? process.env.AWS_SQS_QUEUE_URL!
    : process.env.LOCAL_SQS_QUEUE_NAME!;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 2. Main Polling Loop (one loop per concurrent job)
async function pollQueue(slot: number) {
  const queue = getQueueService();
  Logger.info(`Background worker ${slot}/${concurrency} initialized and polling queue`, {
    provider: process.env.PROVIDER,
    queue: queueUrl,
  });

  while (running) {
    try {
      // Receive at most 1 message
      const messages = await queue.receiveMessages(queueUrl, 1);

      if (messages.length > 0) {
        const message = messages[0];
        activeJobs++;

        try {
          await jobProcessor.processJob(message.ReceiptHandle, message.Body, queueUrl);
        } catch (jobErr: any) {
          Logger.error('Error during message processing', jobErr.message);
        } finally {
          activeJobs--;
        }
      } else {
        // No messages, sleep for 2 seconds before polling again
        await sleep(2000);
      }
    } catch (err: any) {
      Logger.error('Error in polling loop, sleeping for 5 seconds before retry...', err.message);
      await sleep(5000);
    }
  }
}

// Start polling
for (let slot = 1; slot <= concurrency; slot++) {
  pollQueue(slot).catch((err) => {
    Logger.error('Fatal worker loop exception', err);
    process.exit(1);
  });
}

// 3. Graceful Shutdown Handlers
async function handleGracefulShutdown(signal: string) {
  Logger.warn(`Received ${signal}. Setting worker state to stop polling...`);
  running = false;

  // Wait for any active job to finish processing
  let checkAttempts = 0;
  const maxAttempts = 20; // 10 seconds total

  while ((activeJobs > 0) && checkAttempts < maxAttempts) {
    checkAttempts++;
    Logger.info(`Waiting for active job to complete (attempt ${checkAttempts}/${maxAttempts})...`);
    await sleep(500);
  }

  if ((activeJobs > 0)) {
    Logger.error('Forced shutdown: Worker did not complete processing in time.');
    process.exit(1);
  } else {
    Logger.info('Worker shut down cleanly. Exiting process.');
    process.exit(0);
  }
}

process.on('SIGINT', () => handleGracefulShutdown('SIGINT'));
process.on('SIGTERM', () => handleGracefulShutdown('SIGTERM'));
