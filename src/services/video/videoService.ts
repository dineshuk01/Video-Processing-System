import * as path from 'path';
import { VideoRecord, VideoStatus } from '../../types';
import { dbService } from '../db/dbService';
import { getStorageService } from '../storage/storageService';
import { getQueueService } from '../queue/queueService';
import { Logger } from '../../utils/logger';

export class VideoService {
  private allowedMimeTypes: string[];
  private maxFileSizeMb: number;

  constructor() {
    this.allowedMimeTypes = (
      process.env.ALLOWED_MIME_TYPES || 'video/mp4,video/quicktime,video/x-matroska'
    )
      .split(',')
      .map((m) => m.trim().toLowerCase());
    this.maxFileSizeMb = parseInt(process.env.MAX_UPLOAD_SIZE_MB || '100', 10);
  }

  private sanitizeFilename(filename: string): string {
    // Get basename to remove any directory components
    const base = path.basename(filename);
    // Replace characters that are not alphanumeric, dot, dash, or underscore with underscore
    return base.replace(/[^a-zA-Z0-9.-]/g, '_');
  }

  async initiateUpload(params: {
    filename: string;
    contentType: string;
    fileSize: number;
  }): Promise<{ videoId: string; uploadUrl: string; key: string; expiresIn: number }> {
    const sanitizedName = this.sanitizeFilename(params.filename);
    const contentTypeLower = params.contentType.toLowerCase();

    // 1. Validation
    if (!this.allowedMimeTypes.includes(contentTypeLower)) {
      throw new Error(
        `Unsupported content type: ${params.contentType}. Allowed types: ${this.allowedMimeTypes.join(', ')}`
      );
    }

    const maxBytes = this.maxFileSizeMb * 1024 * 1024;
    if (params.fileSize > maxBytes) {
      throw new Error(
        `File size (${(params.fileSize / (1024 * 1024)).toFixed(2)}MB) exceeds limit of ${this.maxFileSizeMb}MB`
      );
    }

    // 2. Generate unique ID & keys
    const videoId =
      Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    const key = `raw/${videoId}/${sanitizedName}`;

    // 3. Create DB record
    await dbService.createVideo({
      id: videoId,
      originalName: sanitizedName,
      fileSize: params.fileSize,
      contentType: contentTypeLower,
    });

    // 4. Generate S3 presigned URL
    const storage = getStorageService();
    const bucket =
      process.env.PROVIDER === 'aws'
        ? process.env.AWS_S3_TEMP_BUCKET!
        : process.env.LOCAL_S3_TEMP_BUCKET!;

    const uploadUrl = await storage.getSignedUrl(bucket, key, 'upload');

    // Update raw object key in db
    await dbService.updateVideo(videoId, { rawObjectKey: key });

    Logger.info(`Initiated upload for video ${videoId} (${sanitizedName})`);
    return {
      videoId,
      uploadUrl,
      key,
      expiresIn: 3600, // 1 hour
    };
  }

  async completeUpload(videoId: string): Promise<VideoRecord> {
    // 1. Retrieve record
    const video = await dbService.getVideo(videoId);
    if (!video) {
      throw new Error(`Video with ID ${videoId} not found`);
    }

    // 2. Idempotency Check
    if (video.status !== VideoStatus.PENDING && video.status !== VideoStatus.UPLOADING) {
      Logger.info(`Upload already complete for video ${videoId}. Current status: ${video.status}`);
      return video;
    }

    // 3. Verify object in storage
    const storage = getStorageService();
    const bucket =
      process.env.PROVIDER === 'aws'
        ? process.env.AWS_S3_TEMP_BUCKET!
        : process.env.LOCAL_S3_TEMP_BUCKET!;
    const key = video.rawObjectKey!;

    const exists = await storage.fileExists(bucket, key);
    if (!exists) {
      throw new Error(`Uploaded file not found in S3 bucket for video: ${videoId}`);
    }

    const metadata = await storage.getObjectMetadata(bucket, key);
    if (metadata.size === 0) {
      throw new Error(`Uploaded file has invalid size (0 bytes) for video: ${videoId}`);
    }

    // 4. Update status in db
    const updatedVideo = await dbService.updateVideo(videoId, {
      status: VideoStatus.UPLOADED,
      fileSize: metadata.size, // update to actual size in case client lied
    });

    // 5. Send message to Queue
    const queue = getQueueService();
    const queueUrl =
      process.env.PROVIDER === 'aws'
        ? process.env.AWS_SQS_QUEUE_URL!
        : process.env.LOCAL_SQS_QUEUE_NAME!;

    const messagePayload = {
      videoId,
      bucket,
      key,
      retryCount: 0,
      timestamp: Date.now(),
    };

    await queue.sendMessage(queueUrl, messagePayload);
    Logger.info(`Enqueued transcoding job for video ${videoId} to queue`, { queueUrl });

    return updatedVideo;
  }

  async getVideos(page: number, limit: number) {
    return dbService.listVideos(page, limit);
  }

  async getVideo(id: string) {
    return dbService.getVideo(id);
  }
}

// Export singleton instance
export const videoService = new VideoService();
