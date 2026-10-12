import { dbService } from '../db/dbService';
import { getQueueService } from '../queue/queueService';
import { getComputeService } from '../compute/computeService';
import { Logger } from '../../utils/logger';
import { VideoStatus } from '../../types';
import {
  transcodeJobsActive,
  transcodeDurationSeconds,
  jobsFailedTotal,
} from '../metrics/metricsService';

const MAX_RETRIES = 3;

// A logging failure must never fail or mask the job itself
const log = (videoId: string, level: 'info' | 'warn' | 'error', message: string) =>
  dbService.appendEvent(videoId, level, message).catch((err) => Logger.warn('Could not write job log', err.message));

export class JobProcessor {
  async processJob(receiptHandle: string, body: string, queueUrl: string): Promise<void> {
    let payload: any;
    try {
      payload = JSON.parse(body);
    } catch (err: any) {
      Logger.error('Failed to parse queue message body, message will be deleted', {
        body,
        error: err.message,
      });
      const queue = getQueueService();
      await queue.deleteMessage(queueUrl, receiptHandle);
      return;
    }

    const { videoId, bucket, key, retryCount = 0 } = payload;
    if (!videoId) {
      Logger.error('Missing videoId in queue message payload, message will be deleted', payload);
      const queue = getQueueService();
      await queue.deleteMessage(queueUrl, receiptHandle);
      return;
    }

    Logger.info(`Worker starting job for video: ${videoId} (Attempt ${retryCount + 1}/${MAX_RETRIES})`);

    const startTime = Date.now();
    transcodeJobsActive.inc();

    try {
      // 1. Fetch video record
      const video = await dbService.getVideo(videoId);
      if (!video) {
        // The video was deleted while the job was queued: nothing to process, don't retry
        Logger.warn(`Video record ${videoId} no longer exists. Dropping its queue message.`);
        await getQueueService().deleteMessage(queueUrl, receiptHandle);
        return;
      }

      // 2. Idempotency check: a finished video's duplicate message is dropped
      if (video.status === VideoStatus.COMPLETED) {
        Logger.info(`Video ${videoId} is already COMPLETED. Deleting duplicate queue message.`);
        const queue = getQueueService();
        await queue.deleteMessage(queueUrl, receiptHandle);
        return;
      }

      // 3. Resolve bucket and key
      const inputBucket = bucket || (
        process.env.PROVIDER === 'aws'
          ? process.env.AWS_S3_TEMP_BUCKET!
          : process.env.LOCAL_S3_TEMP_BUCKET!
      );
      const inputKey = key || video.rawObjectKey!;
      const outputBucket =
        process.env.PROVIDER === 'aws'
          ? process.env.AWS_S3_PUBLIC_BUCKET!
          : process.env.LOCAL_S3_PUBLIC_BUCKET!;
      const outputKeyPrefix = `processed/${videoId}`;

      // 4. Dispatch to compute service
      const attempts = (video.attempts || 0) + 1;
      await dbService.updateVideo(videoId, { attempts });
      await log(videoId, 'info',
        `Attempt ${retryCount + 1} of ${MAX_RETRIES} started (${process.env.PROVIDER === 'aws' ? 'ECS Fargate task' : 'local FFmpeg process'})`);
      Logger.info(`Worker dispatching transcode job (attempt ${retryCount + 1})`, {
        inputBucket,
        inputKey,
        outputBucket,
        outputKeyPrefix,
      });

      const compute = getComputeService();
      await compute.runTranscodeJob({
        videoId,
        inputBucket,
        inputKey,
        outputBucket,
        outputKeyPrefix,
      });

      // Measure duration metric
      const duration = (Date.now() - startTime) / 1000;
      transcodeDurationSeconds.observe(duration);

      // 5. Delete processed message from Queue
      const queue = getQueueService();
      await queue.deleteMessage(queueUrl, receiptHandle);
      await log(videoId, 'info', `Processing finished in ${duration.toFixed(1)}s`);
      Logger.info(`Worker successfully completed job for video: ${videoId} in ${duration.toFixed(1)}s`);
    } catch (err: any) {
      Logger.error(`Job processing failed for video ${videoId} (Attempt ${retryCount + 1}/${MAX_RETRIES})`, err.message);

      const queue = getQueueService();
      const currentRetry = retryCount + 1;

      if (currentRetry >= MAX_RETRIES) {
        // Exceeded max retries -> Move to Dead Letter Queue (DLQ) state
        jobsFailedTotal.inc();
        Logger.error(`Video ${videoId} exceeded max retries (${MAX_RETRIES}). Moving to DLQ state and deleting message from active queue.`);

        try {
          await dbService.updateVideo(videoId, {
            status: VideoStatus.FAILED,
            error: `Permanent failure after ${MAX_RETRIES} attempts: ${err.message}`,
            failedAt: new Date().toISOString(),
          });
        } catch (dbErr: any) {
          Logger.error('Failed to update video status in database', dbErr.message);
        }
        await log(videoId, 'error', `Attempt ${currentRetry} failed: ${err.message}`);
        await log(videoId, 'error', `Giving up after ${MAX_RETRIES} attempts. An admin can retry it from the Jobs page.`);

        // Delete from main queue to prevent infinite reprocessing
        await queue.deleteMessage(queueUrl, receiptHandle);
      } else {
        // Re-enqueue with incremented retry count & exponential backoff delay (15s, 45s)
        const backoffDelayMs = Math.pow(3, currentRetry) * 5000;
        Logger.warn(`Scheduling retry ${currentRetry}/${MAX_RETRIES} for video ${videoId} after ${backoffDelayMs / 1000}s backoff`);

        try {
          await dbService.updateVideo(videoId, {
            status: VideoStatus.UPLOADED, // Reset status to UPLOADED for retry
            error: `Attempt ${currentRetry} failed: ${err.message}. Retrying...`,
          });
        } catch {}
        await log(videoId, 'warn', `Attempt ${currentRetry} failed: ${err.message}`);
        await log(videoId, 'warn', `Retry ${currentRetry + 1} scheduled in ${backoffDelayMs / 1000}s`);

        // The delay is handled by the queue, so a worker restart can't lose the retry
        try {
          await queue.sendMessage(queueUrl, { ...payload, retryCount: currentRetry }, backoffDelayMs / 1000);
          await queue.deleteMessage(queueUrl, receiptHandle);
        } catch (requeueErr: any) {
          Logger.error(`Failed to re-enqueue retry message for video ${videoId}`, requeueErr.message);
          // Keep the original message: it becomes visible again after the visibility timeout
        }
      }

      throw err;
    } finally {
      transcodeJobsActive.dec();
    }
  }
}

export const jobProcessor = new JobProcessor();
