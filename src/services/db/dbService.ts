import * as fs from 'fs';
import * as path from 'path';
import { VideoEvent, VideoRecord, VideoStatus } from '../../types';
import { Logger } from '../../utils/logger';
import { withFileLock, writeFileAtomic } from '../../utils/fileLock';

const MAX_EVENTS_PER_VIDEO = 200;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class WriteMutex {
  private queue: Promise<any> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    let resolveRef: any;
    let rejectRef: any;
    const deferred = new Promise((resolve, reject) => {
      resolveRef = resolve;
      rejectRef = reject;
    });

    // Schedule work in the queue
    this.queue = this.queue
      .then(async () => {
        try {
          const result = await fn();
          resolveRef(result);
        } catch (err) {
          rejectRef(err);
        }
      })
      .catch(() => {}); // swallow chain errors so subsequent tasks still execute

    return deferred as Promise<T>;
  }
}

export interface CreateVideoParams {
  id: string;
  originalName: string;
  fileSize: number;
  contentType: string;
  title?: string;
  qualities?: number[];
  autoPublish?: boolean;
  allowUpscale?: boolean;
}

export class DbService {
  private dbFilePath: string;
  private lockPath: string;
  private mutex: WriteMutex;

  constructor() {
    const dataDir = path.resolve(process.env.LOCAL_DATA_DIR || './data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.dbFilePath = path.join(dataDir, 'db.json');
    this.lockPath = `${this.dbFilePath}.lock`;
    this.mutex = new WriteMutex();
    this.initDb();
  }

  private initDb() {
    if (!fs.existsSync(this.dbFilePath)) {
      fs.writeFileSync(this.dbFilePath, JSON.stringify([], null, 2), 'utf8');
      Logger.info('Initialized clean JSON database file', { path: this.dbFilePath });
    }
  }

  // Readers tolerate a bad read (they just see an empty list); writers must not, or a failed
  // read would be written back as "no videos" and wipe the database.
  private async readAll(strict = false): Promise<VideoRecord[]> {
    for (let attempt = 0; ; attempt++) {
      try {
        const data = await fs.promises.readFile(this.dbFilePath, 'utf8');
        return JSON.parse(data);
      } catch (err: any) {
        if (strict && attempt < 4) { await sleep(25 * (attempt + 1)); continue; }
        if (strict) throw new Error(`Failed to read database file: ${err.message}`);
        Logger.error('Failed to read database file, returning empty array', err.message);
        return [];
      }
    }
  }

  // One read-modify-write, serialised within this process and across processes.
  private transaction<T>(fn: (records: VideoRecord[]) => { result: T; write: boolean }): Promise<T> {
    return this.mutex.run(() =>
      withFileLock(this.lockPath, async () => {
        const records = await this.readAll(true);
        const { result, write } = fn(records);
        if (write) await writeFileAtomic(this.dbFilePath, JSON.stringify(records, null, 2));
        return result;
      })
    );
  }

  async createVideo(params: CreateVideoParams): Promise<VideoRecord> {
    return this.transaction((records) => {
      const now = new Date().toISOString();
      const newVideo: VideoRecord = {
        id: params.id,
        originalName: params.originalName,
        title: params.title,
        status: VideoStatus.PENDING,
        published: false,
        autoPublish: !!params.autoPublish,
        qualities: params.qualities,
        allowUpscale: !!params.allowUpscale,
        attempts: 0,
        events: [{ at: now, level: 'info', message: 'Upload started' }],
        progress: 0,
        fileSize: params.fileSize,
        contentType: params.contentType,
        createdAt: now,
        updatedAt: now,
      };
      records.push(newVideo);
      Logger.info(`Created database record for video: ${params.id}`);
      return { result: newVideo, write: true };
    });
  }

  async getVideo(id: string): Promise<VideoRecord | null> {
    const records = await this.readAll();
    return records.find((v) => v.id === id) || null;
  }

  async updateVideo(id: string, updates: Partial<VideoRecord>): Promise<VideoRecord> {
    return this.transaction((records) => {
      const index = records.findIndex((v) => v.id === id);
      if (index === -1) throw new Error(`Video with ID ${id} not found in database`);

      const now = new Date().toISOString();
      const updatedRecord: VideoRecord = { ...records[index], ...updates, updatedAt: now };

      // Set timestamp transitions based on state changes
      if (updates.status) {
        if (updates.status === VideoStatus.PROCESSING) updatedRecord.processingStartedAt = now;
        else if (updates.status === VideoStatus.COMPLETED) updatedRecord.completedAt = now;
        else if (updates.status === VideoStatus.FAILED) updatedRecord.failedAt = now;
      }
      if (updates.published === true && !records[index].published) updatedRecord.publishedAt = now;

      records[index] = updatedRecord;
      Logger.info(`Updated database record for video: ${id}`, { status: updates.status });
      return { result: updatedRecord, write: true };
    });
  }

  // Appends one line to the video's processing log (kept to the most recent entries)
  async appendEvent(id: string, level: VideoEvent['level'], message: string): Promise<void> {
    await this.transaction((records) => {
      const video = records.find((v) => v.id === id);
      if (!video) return { result: undefined, write: false }; // video deleted meanwhile; nothing to log to
      const now = new Date().toISOString();
      video.events = [...(video.events || []), { at: now, level, message }].slice(-MAX_EVENTS_PER_VIDEO);
      video.updatedAt = now;
      return { result: undefined, write: true };
    });
  }

  async listAll(): Promise<VideoRecord[]> {
    const records = await this.readAll();
    return [...records].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  async listVideos(
    page: number = 1,
    limit: number = 10
  ): Promise<{ videos: VideoRecord[]; total: number; page: number; limit: number }> {
    const sorted = await this.listAll();
    const startIndex = (page - 1) * limit;
    return { videos: sorted.slice(startIndex, startIndex + limit), total: sorted.length, page, limit };
  }

  async deleteVideo(id: string): Promise<boolean> {
    return this.transaction((records) => {
      const index = records.findIndex((v) => v.id === id);
      if (index === -1) return { result: false, write: false };
      records.splice(index, 1);
      Logger.info(`Deleted database record for video: ${id}`);
      return { result: true, write: true };
    });
  }
}

// Export singleton instance
export const dbService = new DbService();
