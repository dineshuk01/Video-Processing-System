import { dbService } from '../db/dbService';
import { getQueueService } from '../queue/queueService';
import { getComputeService } from '../compute/computeService';
import { Logger } from '../../utils/logger';
import { VideoStatus } from '../../types';

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

    const { videoId, bucket, key } = payload;
    if (!videoId) {
      Logger.error('Missing videoId in queue message payload, message will be deleted', payload);
      const queue = getQueueService();
      await queue.deleteMessage(queueUrl, receiptHandle);
      return;
    }

    Logger.info(`Worker starting job for video: ${videoId}`);

    try {
      // 1. Fetch video record
      const video = await dbService.getVideo(videoId);
      if (!video) {
        throw new Error(`Video record ${videoId} not found in database`);
      }

      // 2. Idempotency check
      if (video.status !== VideoStatus.UPLOADED) {
        Logger.warn(`Video ${videoId} has status ${video.status}, expected UPLOADED. Skipping.`);
        const queue = getQueueService();
        await queue.deleteMessage(queueUrl, receiptHandle);
        return;
      }

      // 3. Resolve bucket and key from payload or fall back to video record
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

      // 4. Dispatch to compute (Local child process or AWS ECS Fargate)
      Logger.info(`Worker dispatching transcode job to compute service`, {
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

      // 5. Delete processed message from Queue
      const queue = getQueueService();
      await queue.deleteMessage(queueUrl, receiptHandle);
      Logger.info(`Worker successfully dispatched and completed job for video: ${videoId}`);
    } catch (err: any) {
      Logger.error(`Job processing failed for video ${videoId}`, err.message);

      // Update database status to FAILED (transcoderTask.ts also does this but best-effort here too)
      try {
        const currentRecord = await dbService.getVideo(videoId);
        if (currentRecord && currentRecord.status !== VideoStatus.FAILED) {
          await dbService.updateVideo(videoId, {
            status: VideoStatus.FAILED,
            error: err.message || 'Unknown processing error',
          });
        }
      } catch (dbErr: any) {
        Logger.error('Failed to update video status to FAILED in database', dbErr.message);
      }

      // Do NOT delete the message from the queue so it can be retried
      throw err;
    }
  }
}

export const jobProcessor = new JobProcessor();
