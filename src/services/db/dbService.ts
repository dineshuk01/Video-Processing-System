import * as fs from 'fs';
import * as path from 'path';
import { VideoRecord, VideoStatus } from '../../types';
import { Logger } from '../../utils/logger';

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

export class DbService {
  private dbFilePath: string;
  private mutex: WriteMutex;

  constructor() {
    const dataDir = path.resolve(process.env.LOCAL_DATA_DIR || './data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.dbFilePath = path.join(dataDir, 'db.json');
    this.mutex = new WriteMutex();
    this.initDb();
  }

  private initDb() {
    if (!fs.existsSync(this.dbFilePath)) {
      fs.writeFileSync(this.dbFilePath, JSON.stringify([], null, 2), 'utf8');
      Logger.info('Initialized clean JSON database file', { path: this.dbFilePath });
    }
  }

  private async readAll(): Promise<VideoRecord[]> {
    try {
      const data = await fs.promises.readFile(this.dbFilePath, 'utf8');
      return JSON.parse(data);
    } catch (err: any) {
      Logger.error('Failed to read database file, returning empty array', err.message);
      return [];
    }
  }

  private async writeAll(records: VideoRecord[]): Promise<void> {
    await fs.promises.writeFile(this.dbFilePath, JSON.stringify(records, null, 2), 'utf8');
  }

  async createVideo(params: {
    id: string;
    originalName: string;
    fileSize: number;
    contentType: string;
  }): Promise<VideoRecord> {
    return this.mutex.run(async () => {
      const records = await this.readAll();
      
      const now = new Date().toISOString();
      const newVideo: VideoRecord = {
        id: params.id,
        originalName: params.originalName,
        status: VideoStatus.PENDING,
        progress: 0,
        fileSize: params.fileSize,
        contentType: params.contentType,
        createdAt: now,
        updatedAt: now,
      };

      records.push(newVideo);
      await this.writeAll(records);
      Logger.info(`Created database record for video: ${params.id}`);
      return newVideo;
    });
  }

  async getVideo(id: string): Promise<VideoRecord | null> {
    const records = await this.readAll();
    const video = records.find((v) => v.id === id);
    return video || null;
  }

  async updateVideo(id: string, updates: Partial<VideoRecord>): Promise<VideoRecord> {
    return this.mutex.run(async () => {
      const records = await this.readAll();
      const index = records.findIndex((v) => v.id === id);

      if (index === -1) {
        throw new Error(`Video with ID ${id} not found in database`);
      }

      const now = new Date().toISOString();
      const updatedRecord: VideoRecord = {
        ...records[index],
        ...updates,
        updatedAt: now,
      };

      // Set timestamp transitions based on state changes
      if (updates.status) {
        if (updates.status === VideoStatus.PROCESSING) {
          updatedRecord.processingStartedAt = now;
        } else if (updates.status === VideoStatus.COMPLETED) {
          updatedRecord.completedAt = now;
        } else if (updates.status === VideoStatus.FAILED) {
          updatedRecord.failedAt = now;
        }
      }

      records[index] = updatedRecord;
      await this.writeAll(records);
      Logger.info(`Updated database record for video: ${id}`, { status: updates.status });
      return updatedRecord;
    });
  }

  async listVideos(
    page: number = 1,
    limit: number = 10
  ): Promise<{ videos: VideoRecord[]; total: number; page: number; limit: number }> {
    const records = await this.readAll();
    // Sort by createdAt descending
    const sorted = [...records].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    const total = sorted.length;
    const startIndex = (page - 1) * limit;
    const paginated = sorted.slice(startIndex, startIndex + limit);

    return {
      videos: paginated,
      total,
      page,
      limit,
    };
  }
}

// Export singleton instance
export const dbService = new DbService();
