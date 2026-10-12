import * as path from 'path';
import { AVAILABLE_QUALITIES, VideoRecord, VideoStatus } from '../../types';
import { dbService } from '../db/dbService';
import { getStorageService } from '../storage/storageService';
import { getQueueService } from '../queue/queueService';
import { Logger } from '../../utils/logger';
import { HttpError } from '../../utils/responseHandler';
import { cdnService } from '../cdn/cdnService';
import { clearPublishedCache } from './publishedCache';

// What the public site may know about a video. Nothing about jobs, errors, storage keys or sizes.
export interface PublicVideo {
  id: string;
  title: string;
  thumbnailUrl?: string;
  hlsPlaylistUrl: string;
  subtitleUrl?: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  publishedAt: string;
}

export class VideoService {
  private get allowedMimeTypes(): string[] {
    return (process.env.ALLOWED_MIME_TYPES || 'video/mp4,video/quicktime,video/x-matroska')
      .split(',')
      .map((m) => m.trim().toLowerCase());
  }

  private get maxFileSizeMb(): number {
    return parseInt(process.env.MAX_UPLOAD_SIZE_MB || '1000', 10);
  }

  private get buckets() {
    const aws = process.env.PROVIDER === 'aws';
    return {
      temp: aws ? process.env.AWS_S3_TEMP_BUCKET! : process.env.LOCAL_S3_TEMP_BUCKET!,
      public: aws ? process.env.AWS_S3_PUBLIC_BUCKET! : process.env.LOCAL_S3_PUBLIC_BUCKET!,
      queue: aws ? process.env.AWS_SQS_QUEUE_URL! : process.env.LOCAL_SQS_QUEUE_NAME!,
    };
  }

  private sanitizeFilename(filename: string): string {
    // Get basename to remove any directory components
    const base = path.basename(filename);
    // Replace characters that are not alphanumeric, dot, dash, or underscore with underscore
    return base.replace(/[^a-zA-Z0-9.-]/g, '_');
  }

  // Accepts e.g. [720, 360] or ["720"]; returns a sorted unique list or throws a 400
  private parseQualities(input: unknown): number[] | undefined {
    if (input === undefined || input === null) return undefined;
    if (!Array.isArray(input) || input.length === 0) {
      throw new HttpError('qualities must be a non-empty list, e.g. [360, 720]', 400, 'INVALID_QUALITIES');
    }
    const parsed = [...new Set(input.map((q) => Number(q)))].sort((a, b) => a - b);
    if (parsed.some((q) => !(AVAILABLE_QUALITIES as readonly number[]).includes(q))) {
      throw new HttpError(`qualities must be chosen from ${AVAILABLE_QUALITIES.join(', ')}`, 400, 'INVALID_QUALITIES');
    }
    return parsed;
  }

  private parseTitle(input: unknown): string | undefined {
    if (input === undefined || input === null) return undefined;
    if (typeof input !== 'string') throw new HttpError('title must be text', 400, 'INVALID_TITLE');
    const title = input.trim().replace(/\s+/g, ' ');
    if (title.length > 120) throw new HttpError('title must be 120 characters or fewer', 400, 'INVALID_TITLE');
    return title || undefined;
  }

  async initiateUpload(params: {
    filename: string;
    contentType: string;
    fileSize: number;
    title?: unknown;
    qualities?: unknown;
    autoPublish?: unknown;
  }): Promise<{ videoId: string; uploadUrl: string; key: string; expiresIn: number }> {
    const sanitizedName = this.sanitizeFilename(params.filename);
    const contentTypeLower = params.contentType.toLowerCase();

    // 1. Validation
    if (!this.allowedMimeTypes.includes(contentTypeLower)) {
      throw new HttpError(
        `Unsupported content type: ${params.contentType}. Allowed types: ${this.allowedMimeTypes.join(', ')}`, 400, 'UNSUPPORTED_TYPE'
      );
    }

    const maxFileSizeMb = this.maxFileSizeMb;
    const maxBytes = maxFileSizeMb * 1024 * 1024;
    if (params.fileSize > maxBytes) {
      throw new HttpError(
        `File size (${(params.fileSize / (1024 * 1024)).toFixed(2)}MB) exceeds limit of ${maxFileSizeMb}MB`, 413, 'PAYLOAD_TOO_LARGE'
      );
    }
    const qualities = this.parseQualities(params.qualities);
    const title = this.parseTitle(params.title);

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
      title,
      qualities,
      autoPublish: params.autoPublish === true,
    });

    // 4. Generate S3 presigned URL
    const uploadUrl = await getStorageService().getSignedUrl(this.buckets.temp, key, 'upload');

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
      throw new HttpError(`Video with ID ${videoId} not found`, 404, 'NOT_FOUND');
    }

    // 2. Idempotency Check
    if (video.status !== VideoStatus.PENDING && video.status !== VideoStatus.UPLOADING) {
      Logger.info(`Upload already complete for video ${videoId}. Current status: ${video.status}`);
      return video;
    }

    // 3. Verify object in storage
    const storage = getStorageService();
    const key = video.rawObjectKey!;

    const exists = await storage.fileExists(this.buckets.temp, key);
    if (!exists) {
      throw new HttpError(`Uploaded file not found in storage for video: ${videoId}`, 409, 'UPLOAD_MISSING');
    }

    const metadata = await storage.getObjectMetadata(this.buckets.temp, key);
    if (metadata.size === 0) {
      throw new HttpError(`Uploaded file has invalid size (0 bytes) for video: ${videoId}`, 400, 'EMPTY_UPLOAD');
    }

    // 4. Update status in db
    const updatedVideo = await dbService.updateVideo(videoId, {
      status: VideoStatus.UPLOADED,
      fileSize: metadata.size, // update to actual size in case client lied
    });
    await dbService.appendEvent(videoId, 'info', 'Upload verified. Queued for processing.');

    // 5. Send message to Queue
    await this.enqueue(videoId, key);
    return updatedVideo;
  }

  private async enqueue(videoId: string, key: string) {
    const { temp, queue } = this.buckets;
    await getQueueService().sendMessage(queue, { videoId, bucket: temp, key, retryCount: 0, timestamp: Date.now() });
    Logger.info(`Enqueued transcoding job for video ${videoId} to queue`, { queueUrl: queue });
  }

  // ─── Admin: management ─────────────────────────────────────

  async setPublished(id: string, published: boolean): Promise<VideoRecord> {
    const video = await dbService.getVideo(id);
    if (!video) throw new HttpError(`Video with ID ${id} not found`, 404, 'NOT_FOUND');
    if (published && video.status !== VideoStatus.COMPLETED) {
      throw new HttpError('Only videos that finished processing can be published', 409, 'NOT_READY');
    }
    if (!!video.published === published) return video;
    const updated = await dbService.updateVideo(id, { published });
    clearPublishedCache(id);
    await dbService.appendEvent(id, 'info', published ? 'Published to the public site' : 'Unpublished from the public site');
    return updated;
  }

  async updateSettings(id: string, input: { title?: unknown; qualities?: unknown; autoPublish?: unknown }): Promise<VideoRecord> {
    const video = await dbService.getVideo(id);
    if (!video) throw new HttpError(`Video with ID ${id} not found`, 404, 'NOT_FOUND');

    const updates: Partial<VideoRecord> = {};
    const changes: string[] = [];
    if (input.title !== undefined) {
      updates.title = this.parseTitle(input.title);
      changes.push('title');
    }
    if (input.qualities !== undefined) {
      updates.qualities = this.parseQualities(input.qualities);
      changes.push('quality settings (applied the next time the video is processed)');
    }
    if (input.autoPublish !== undefined) {
      updates.autoPublish = input.autoPublish === true;
      changes.push('auto-publish');
    }
    if (changes.length === 0) return video;
    const updated = await dbService.updateVideo(id, updates);
    await dbService.appendEvent(id, 'info', `Settings updated: ${changes.join(', ')}`);
    return updated;
  }

  // Stop a queued or running job and hold the video. The original upload is kept; Resume starts
  // processing again from the beginning. A running transcode notices within a couple of seconds.
  async pauseVideo(id: string): Promise<VideoRecord> {
    const video = await dbService.getVideo(id);
    if (!video) throw new HttpError(`Video with ID ${id} not found`, 404, 'NOT_FOUND');
    if (video.status === VideoStatus.PAUSED) return video;
    if (video.status !== VideoStatus.PROCESSING && video.status !== VideoStatus.UPLOADED) {
      throw new HttpError(`Only queued or processing videos can be paused (this one is ${video.status.toLowerCase()})`, 409, 'NOT_PAUSABLE');
    }
    const updated = await dbService.updateVideo(id, { status: VideoStatus.PAUSED, error: undefined });
    await dbService.appendEvent(id, 'warn',
      video.status === VideoStatus.PROCESSING
        ? 'Paused by an admin. Processing is stopping; resuming starts again from the beginning.'
        : 'Paused by an admin before processing started');
    return updated;
  }

  // Remove the processed (HLS) output but keep the original upload, so it can be processed again
  async deleteProcessed(id: string): Promise<VideoRecord> {
    const video = await dbService.getVideo(id);
    if (!video) throw new HttpError(`Video with ID ${id} not found`, 404, 'NOT_FOUND');
    if (video.status === VideoStatus.PROCESSING || video.status === VideoStatus.UPLOADED) {
      throw new HttpError('Pause the video first, then delete its processed files', 409, 'STILL_PROCESSING');
    }
    const storage = getStorageService();
    if (!video.rawObjectKey || !(await storage.fileExists(this.buckets.temp, video.rawObjectKey))) {
      throw new HttpError('The original upload is gone, so deleting the processed files would leave nothing to play or reprocess. Delete the whole video instead.', 409, 'NO_SOURCE');
    }
    await storage.deleteDirectory(this.buckets.public, `processed/${id}`);
    clearPublishedCache(id);
    const updated = await dbService.updateVideo(id, {
      status: VideoStatus.PAUSED,
      published: false,
      progress: 0,
      error: undefined,
      failedAt: undefined,
      completedAt: undefined,
      hlsPlaylistUrl: undefined,
      thumbnailUrl: undefined,
      subtitleUrl: undefined,
    });
    await dbService.appendEvent(id, 'warn', 'Processed files deleted by an admin. The original is kept; resume to process it again.');
    return updated;
  }

  // Re-run processing for a failed video, or reprocess a finished one (e.g. with new qualities)
  async retryVideo(id: string, input: { qualities?: unknown } = {}): Promise<VideoRecord> {
    const video = await dbService.getVideo(id);
    if (!video) throw new HttpError(`Video with ID ${id} not found`, 404, 'NOT_FOUND');
    if (![VideoStatus.FAILED, VideoStatus.COMPLETED, VideoStatus.UPLOADED, VideoStatus.PAUSED].includes(video.status)) {
      throw new HttpError(`A ${video.status.toLowerCase()} video cannot be retried right now`, 409, 'NOT_RETRYABLE');
    }
    if (!video.rawObjectKey) throw new HttpError('The original upload is no longer available', 409, 'NO_SOURCE');

    const storage = getStorageService();
    if (!(await storage.fileExists(this.buckets.temp, video.rawObjectKey))) {
      throw new HttpError('The original upload has been removed, so it cannot be processed again. Upload it again.', 409, 'NO_SOURCE');
    }

    const qualities = input.qualities !== undefined ? this.parseQualities(input.qualities) : video.qualities;
    await storage.deleteDirectory(this.buckets.public, `processed/${id}`); // drop old renditions
    const updated = await dbService.updateVideo(id, {
      status: VideoStatus.UPLOADED,
      progress: 0,
      error: undefined,
      failedAt: undefined,
      completedAt: undefined,
      hlsPlaylistUrl: undefined,
      thumbnailUrl: undefined,
      subtitleUrl: undefined,
      qualities,
    });
    const verb = video.status === VideoStatus.PAUSED ? 'Resumed' : 'Retry requested';
    await dbService.appendEvent(id, 'info', `${verb} by an admin${qualities ? ` (qualities: ${qualities.join(', ')}p)` : ''}`);
    await this.enqueue(id, video.rawObjectKey);
    return updated;
  }

  private applyCdnUrls(video: VideoRecord): VideoRecord {
    if (!cdnService.isEnabled()) {
      return video;
    }
    const outputKeyPrefix = `processed/${video.id}`;
    const hlsPlaylistUrl = cdnService.getPlaylistUrl(outputKeyPrefix, video.hlsPlaylistUrl || '');
    const thumbnailUrl = video.thumbnailUrl
      ? cdnService.getPosterUrl(outputKeyPrefix, video.thumbnailUrl)
      : undefined;
    const subtitleUrl = video.subtitleUrl
      ? cdnService.getSubtitleUrl(outputKeyPrefix, 'subtitles_en.vtt', video.subtitleUrl)
      : undefined;

    return {
      ...video,
      hlsPlaylistUrl: video.hlsPlaylistUrl ? hlsPlaylistUrl : undefined,
      thumbnailUrl: video.thumbnailUrl ? thumbnailUrl : undefined,
      subtitleUrl: video.subtitleUrl ? subtitleUrl : undefined,
    };
  }

  async getVideos(page: number, limit: number) {
    const result = await dbService.listVideos(page, limit);
    result.videos = result.videos.map((v) => this.applyCdnUrls(v));
    return result;
  }

  async getVideo(id: string) {
    const video = await dbService.getVideo(id);
    if (!video) return null;
    return this.applyCdnUrls(video);
  }

  async deleteVideo(id: string): Promise<void> {
    const video = await dbService.getVideo(id);
    if (!video) {
      throw new HttpError(`Video with ID ${id} not found`, 404, 'NOT_FOUND');
    }

    const storage = getStorageService();
    const { temp: tempBucket, public: publicBucket } = this.buckets;

    if (video.status === VideoStatus.PROCESSING) {
      Logger.info(`Deleting video ${id} while it is processing. The transcoder will stop on its own.`);
    }

    // 1. Delete raw input file if exists
    if (video.rawObjectKey) {
      try {
        await storage.deleteObject(tempBucket, video.rawObjectKey);
        // Also remove the containing directory locally
        await storage.deleteDirectory(tempBucket, `raw/${id}`);
      } catch (err: any) {
        Logger.warn(`Failed to delete raw object ${video.rawObjectKey} for video ${id}`, err.message);
      }
    }

    // 2. Delete processed HLS directory
    try {
      await storage.deleteDirectory(publicBucket, `processed/${id}`);
    } catch (err: any) {
      Logger.warn(`Failed to delete processed directory for video ${id}`, err.message);
    }

    // 3. Delete from DB
    await dbService.deleteVideo(id);
    clearPublishedCache(id);
    Logger.info(`Successfully deleted video ${id} and all associated resources`);
  }

  // ─── Public site ───────────────────────────────────────────

  isPublic(video: VideoRecord): boolean {
    return !!video.published && video.status === VideoStatus.COMPLETED && !!video.hlsPlaylistUrl;
  }

  toPublic(video: VideoRecord): PublicVideo {
    const v = this.applyCdnUrls(video);
    return {
      id: v.id,
      title: v.title || v.originalName.replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim() || v.originalName,
      thumbnailUrl: v.thumbnailUrl,
      hlsPlaylistUrl: v.hlsPlaylistUrl!,
      subtitleUrl: v.subtitleUrl,
      duration: v.metadata?.duration || 0,
      width: v.metadata?.width || 0,
      height: v.metadata?.height || 0,
      fps: v.metadata?.fps || 0,
      publishedAt: v.publishedAt || v.completedAt || v.createdAt,
    };
  }

  // Published videos, newest first. Uses the same data as the admin app but exposes only PublicVideo.
  async listPublished(): Promise<PublicVideo[]> {
    const all = await dbService.listAll();
    return all
      .filter((v) => this.isPublic(v))
      .map((v) => this.toPublic(v))
      .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  }

  async getPublished(id: string): Promise<PublicVideo | null> {
    const video = await dbService.getVideo(id);
    return video && this.isPublic(video) ? this.toPublic(video) : null;
  }
}

// Export singleton instance
export const videoService = new VideoService();
