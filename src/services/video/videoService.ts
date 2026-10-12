import * as path from 'path';
import { AVAILABLE_QUALITIES, Series, VideoRecord, VideoStatus } from '../../types';
import { dbService } from '../db/dbService';
import { getStorageService } from '../storage/storageService';
import { getQueueService } from '../queue/queueService';
import { Logger } from '../../utils/logger';
import { HttpError } from '../../utils/responseHandler';
import { cdnService } from '../cdn/cdnService';
import { clearPublishedCache } from './publishedCache';
import { seriesService, parseSeasonNumber, parseEpisodeNumber } from '../series/seriesService';
import { publicUrlFor } from '../storage/publicUrl';
import * as thumbs from '../thumbnail/thumbnailService';

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
  /** Present when the video is an episode of a series */
  episode?: {
    seriesId: string;
    seriesTitle: string;
    season: number;
    episode: number;
    nextId?: string;
    prevId?: string;
  };
}

export interface PublicEpisode {
  id: string;
  title: string;
  season: number;
  episode: number;
  duration: number;
  height: number;
  thumbnailUrl?: string;
  publishedAt: string;
}

export interface PublicSeries {
  id: string;
  title: string;
  description?: string;
  posterUrl?: string;
  seasonCount: number;
  episodeCount: number;
  seasons: { number: number; episodes: PublicEpisode[] }[];
  publishedAt: string;   // when the newest visible episode was published
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
    allowUpscale?: unknown;
    seriesId?: unknown;
    seasonNumber?: unknown;
    episodeNumber?: unknown;
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
    // Uploading straight into a series: check the slot before anything is created
    const slot = params.seriesId ? await this.resolveEpisodeSlot(params, undefined, true) : undefined;

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
      allowUpscale: params.allowUpscale === true,
      ...(slot || {}),
    });
    if (slot) await seriesService.ensureSeason(slot.seriesId, slot.seasonNumber);

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

  async updateSettings(id: string, input: { title?: unknown; qualities?: unknown; autoPublish?: unknown; allowUpscale?: unknown }): Promise<VideoRecord> {
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
    if (input.allowUpscale !== undefined) {
      updates.allowUpscale = input.allowUpscale === true;
      changes.push('upscaling (applied the next time the video is processed)');
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
      renditions: undefined,
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
      renditions: undefined,
      qualities,
    });
    const verb = video.status === VideoStatus.PAUSED ? 'Resumed' : 'Retry requested';
    await dbService.appendEvent(id, 'info', `${verb} by an admin${qualities ? ` (qualities: ${qualities.join(', ')}p)` : ''}`);
    await this.enqueue(id, video.rawObjectKey);
    return updated;
  }

  // The video as a client should see it: CDN addresses, and the admin's own thumbnail if one was set
  private applyCdnUrls(video: VideoRecord): VideoRecord {
    const withCdn = this.withCdnUrls(video);
    return video.customThumbnailKey ? { ...withCdn, thumbnailUrl: publicUrlFor(video.customThumbnailKey) } : withCdn;
  }

  /** Same as above, for code outside this class (live updates) */
  present(video: VideoRecord): VideoRecord {
    return this.applyCdnUrls(video);
  }

  private withCdnUrls(video: VideoRecord): VideoRecord {
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

    // 3. Delete the admin's custom thumbnail, if any
    await thumbs.removeAllThumbnails(id);

    // 4. Delete from DB
    await dbService.deleteVideo(id);
    clearPublishedCache(id);
    Logger.info(`Successfully deleted video ${id} and all associated resources`);
  }

  // ─── Thumbnails ────────────────────────────────────────────

  private async requireVideo(id: string): Promise<VideoRecord> {
    const video = await dbService.getVideo(id);
    if (!video) throw new HttpError(`Video with ID ${id} not found`, 404, 'NOT_FOUND');
    return video;
  }

  // Replace the thumbnail with an uploaded image (JPEG, PNG or WebP)
  async setThumbnailFromImage(id: string, image: Buffer): Promise<VideoRecord> {
    const video = await this.requireVideo(id);
    const key = await thumbs.storeThumbnail(id, await thumbs.imageToJpeg(image));
    const updated = await dbService.updateVideo(id, { customThumbnailKey: key });
    await thumbs.removeThumbnail(video.customThumbnailKey);
    await dbService.appendEvent(id, 'info', 'Thumbnail replaced by an admin (uploaded image)');
    return this.applyCdnUrls(updated);
  }

  // Use a frame of the original upload (at `seconds`) as the thumbnail
  async setThumbnailFromFrame(id: string, seconds: unknown): Promise<VideoRecord> {
    const video = await this.requireVideo(id);
    const at = Number(seconds);
    if (!Number.isFinite(at) || at < 0) throw new HttpError('seconds must be a number of 0 or more', 400, 'INVALID_TIME');
    const duration = video.metadata?.duration || 0;
    if (duration && at > duration) throw new HttpError(`That is past the end of the video (${Math.floor(duration)} s)`, 400, 'INVALID_TIME');

    const storage = getStorageService();
    if (!video.rawObjectKey || !(await storage.fileExists(this.buckets.temp, video.rawObjectKey))) {
      throw new HttpError('The original upload is gone, so a frame can\'t be taken. Upload an image instead.', 409, 'NO_SOURCE');
    }
    // Local: read the file in place. AWS: let FFmpeg read just what it needs over a presigned URL.
    const input = process.env.PROVIDER === 'aws'
      ? await storage.getSignedUrl(this.buckets.temp, video.rawObjectKey, 'download')
      : path.join(path.resolve(process.env.LOCAL_DATA_DIR || './data'), this.buckets.temp, video.rawObjectKey);

    const key = await thumbs.storeThumbnail(id, await thumbs.frameToJpeg(input, at));
    const updated = await dbService.updateVideo(id, { customThumbnailKey: key });
    await thumbs.removeThumbnail(video.customThumbnailKey);
    await dbService.appendEvent(id, 'info', `Thumbnail set by an admin (frame at ${at.toFixed(1)} s)`);
    return this.applyCdnUrls(updated);
  }

  // Back to the automatic thumbnail
  async resetThumbnail(id: string): Promise<VideoRecord> {
    const video = await this.requireVideo(id);
    if (!video.customThumbnailKey) return this.applyCdnUrls(video);
    const updated = await dbService.updateVideo(id, { customThumbnailKey: undefined });
    await thumbs.removeThumbnail(video.customThumbnailKey);
    await dbService.appendEvent(id, 'info', 'Thumbnail reset to the automatic one');
    return this.applyCdnUrls(updated);
  }

  // The poster a series shows: the admin's own, else the first episode's thumbnail
  seriesPosterUrl(series: Series, episodes: VideoRecord[]): string | undefined {
    if (series.posterKey) return publicUrlFor(series.posterKey);
    return episodes.map((e) => this.applyCdnUrls(e)).find((e) => e.thumbnailUrl)?.thumbnailUrl;
  }

  async setSeriesPoster(id: string, image: Buffer): Promise<Series> {
    const series = await seriesService.require(id);
    const key = await thumbs.storeThumbnail(`series_${id}`, await thumbs.imageToJpeg(image));
    const updated = await seriesService.setPoster(id, key);
    await thumbs.removeThumbnail(series.posterKey);
    return updated;
  }

  async resetSeriesPoster(id: string): Promise<Series> {
    const series = await seriesService.require(id);
    if (!series.posterKey) return series;
    const updated = await seriesService.setPoster(id, undefined);
    await thumbs.removeThumbnail(series.posterKey);
    return updated;
  }

  // ─── Series / episodes ─────────────────────────────────────

  // Checks a (series, season, episode) slot and returns it normalised. `autoNumber` picks the
  // next free episode number when none is given (used when uploading into a season).
  async resolveEpisodeSlot(
    input: { seriesId?: unknown; seasonNumber?: unknown; episodeNumber?: unknown },
    excludeVideoId?: string,
    autoNumber = false
  ): Promise<{ seriesId: string; seasonNumber: number; episodeNumber: number }> {
    if (typeof input.seriesId !== 'string' || !input.seriesId) throw new HttpError('seriesId is required', 400, 'INVALID_SERIES');
    await seriesService.require(input.seriesId);
    const seasonNumber = parseSeasonNumber(input.seasonNumber ?? 1);
    const siblings = (await dbService.listAll()).filter((v) => v.seriesId === input.seriesId && v.seasonNumber === seasonNumber && v.id !== excludeVideoId);
    const episodeNumber = input.episodeNumber === undefined || input.episodeNumber === null || input.episodeNumber === ''
      ? (autoNumber ? Math.max(0, ...siblings.map((v) => v.episodeNumber || 0)) + 1 : parseEpisodeNumber(input.episodeNumber))
      : parseEpisodeNumber(input.episodeNumber);
    const clash = siblings.find((v) => v.episodeNumber === episodeNumber);
    if (clash) {
      throw new HttpError(`Season ${seasonNumber}, episode ${episodeNumber} is already used by "${clash.title || clash.originalName}"`, 409, 'EPISODE_TAKEN');
    }
    return { seriesId: input.seriesId, seasonNumber, episodeNumber };
  }

  // Attach a video to a series, or move / renumber it inside one
  async assignEpisode(id: string, input: { seriesId?: unknown; seasonNumber?: unknown; episodeNumber?: unknown }): Promise<VideoRecord> {
    const video = await dbService.getVideo(id);
    if (!video) throw new HttpError(`Video with ID ${id} not found`, 404, 'NOT_FOUND');
    const slot = await this.resolveEpisodeSlot(input, id);
    const series = await seriesService.ensureSeason(slot.seriesId, slot.seasonNumber);
    const updated = await dbService.updateVideo(id, slot);
    await dbService.appendEvent(id, 'info', `Set as ${series.title}, season ${slot.seasonNumber}, episode ${slot.episodeNumber}`);
    clearPublishedCache();
    return updated;
  }

  // Take a video out of its series. It becomes a standalone draft so it can't suddenly appear as a movie.
  async detachEpisode(id: string): Promise<VideoRecord> {
    const video = await dbService.getVideo(id);
    if (!video) throw new HttpError(`Video with ID ${id} not found`, 404, 'NOT_FOUND');
    if (!video.seriesId) return video;
    const updated = await dbService.updateVideo(id, { seriesId: undefined, seasonNumber: undefined, episodeNumber: undefined, published: false });
    await dbService.appendEvent(id, 'info', 'Removed from its series (now a standalone draft)');
    clearPublishedCache();
    return updated;
  }

  async episodesOf(seriesId: string): Promise<VideoRecord[]> {
    return (await dbService.listAll())
      .filter((v) => v.seriesId === seriesId)
      .sort((a, b) => (a.seasonNumber! - b.seasonNumber!) || (a.episodeNumber! - b.episodeNumber!));
  }

  // Episodes as the admin sees them (CDN-applied thumbnails etc.), in order
  async episodesForAdmin(seriesId: string): Promise<VideoRecord[]> {
    return (await this.episodesOf(seriesId)).map((v) => this.applyCdnUrls(v));
  }

  async deleteSeries(id: string, deleteVideos: boolean): Promise<void> {
    await seriesService.require(id);
    for (const episode of await this.episodesOf(id)) {
      if (deleteVideos) await this.deleteVideo(episode.id);
      else await this.detachEpisode(episode.id);
    }
    await thumbs.removeAllThumbnails(`series_${id}`);
    await seriesService.delete(id);
    clearPublishedCache();
  }

  // ─── Public site ───────────────────────────────────────────

  // A video is basic-public when it finished processing and was published
  isPublic(video: VideoRecord): boolean {
    return !!video.published && video.status === VideoStatus.COMPLETED && !!video.hlsPlaylistUrl;
  }

  // ...and visible when, if it is an episode, its series is published too
  async isVisible(video: VideoRecord): Promise<boolean> {
    if (!this.isPublic(video)) return false;
    if (!video.seriesId) return true;
    const series = await seriesService.get(video.seriesId);
    return !!series && series.published;
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

  private toPublicEpisode(video: VideoRecord): PublicEpisode {
    const p = this.toPublic(video);
    return {
      id: p.id,
      title: p.title,
      season: video.seasonNumber ?? 1,
      episode: video.episodeNumber ?? 0,
      duration: p.duration,
      height: p.height,
      thumbnailUrl: p.thumbnailUrl,
      publishedAt: p.publishedAt,
    };
  }

  private buildPublicSeries(series: Series, episodes: VideoRecord[]): PublicSeries {
    const ordered = [...episodes].sort((a, b) => (a.seasonNumber! - b.seasonNumber!) || (a.episodeNumber! - b.episodeNumber!));
    const bySeason = new Map<number, PublicEpisode[]>();
    for (const e of ordered) {
      const list = bySeason.get(e.seasonNumber ?? 1) || [];
      list.push(this.toPublicEpisode(e));
      bySeason.set(e.seasonNumber ?? 1, list);
    }
    const seasons = [...bySeason.entries()].sort((a, b) => a[0] - b[0]).map(([number, eps]) => ({ number, episodes: eps }));
    const latest = ordered.map((e) => this.toPublic(e).publishedAt).sort().pop() || series.publishedAt || series.createdAt;
    return {
      id: series.id,
      title: series.title,
      description: series.description,
      posterUrl: series.posterKey ? publicUrlFor(series.posterKey) : ordered.length ? this.toPublic(ordered.find((e) => e.thumbnailUrl) || ordered[0]).thumbnailUrl : undefined,
      seasonCount: seasons.length,
      episodeCount: ordered.length,
      seasons,
      publishedAt: latest,
    };
  }

  // Standalone published videos (movies), newest first. Episodes are listed through their series.
  async listPublished(): Promise<PublicVideo[]> {
    const all = await dbService.listAll();
    return all
      .filter((v) => !v.seriesId && this.isPublic(v))
      .map((v) => this.toPublic(v))
      .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  }

  // Published series that have at least one published, finished episode
  async listPublicSeries(): Promise<PublicSeries[]> {
    const [allSeries, videos] = await Promise.all([seriesService.list(), dbService.listAll()]);
    return allSeries
      .filter((s) => s.published)
      .map((s) => this.buildPublicSeries(s, videos.filter((v) => v.seriesId === s.id && this.isPublic(v))))
      .filter((s) => s.episodeCount > 0)
      .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  }

  async getPublicSeries(id: string): Promise<PublicSeries | null> {
    const series = await seriesService.get(id);
    if (!series || !series.published) return null;
    const episodes = (await this.episodesOf(id)).filter((v) => this.isPublic(v));
    return episodes.length ? this.buildPublicSeries(series, episodes) : null;
  }

  async getPublished(id: string): Promise<PublicVideo | null> {
    const video = await dbService.getVideo(id);
    if (!video || !(await this.isVisible(video))) return null;
    const result = this.toPublic(video);
    if (video.seriesId) {
      const series = (await seriesService.get(video.seriesId))!;
      const visible = (await this.episodesOf(video.seriesId)).filter((v) => this.isPublic(v));
      const index = visible.findIndex((v) => v.id === id);
      result.episode = {
        seriesId: series.id,
        seriesTitle: series.title,
        season: video.seasonNumber ?? 1,
        episode: video.episodeNumber ?? 0,
        nextId: visible[index + 1]?.id,
        prevId: visible[index - 1]?.id,
      };
    }
    return result;
  }
}

// Export singleton instance
export const videoService = new VideoService();
