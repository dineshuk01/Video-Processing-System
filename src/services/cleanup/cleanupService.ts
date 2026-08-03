import * as fs from 'fs';
import * as path from 'path';
import { dbService } from '../db/dbService';
import { Logger } from '../../utils/logger';
import { VideoStatus } from '../../types';

export class CleanupService {
  private tempDir: string;
  private rawUploadDir: string;

  constructor() {
    const dataDir = path.resolve(process.env.LOCAL_DATA_DIR || './data');
    this.tempDir = path.join(dataDir, 'temp');
    this.rawUploadDir = path.join(dataDir, 's3-temp', 'raw');
  }

  // Clean up leftover scratch directories from temp processing
  async cleanTempDirectories(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<number> {
    if (!fs.existsSync(this.tempDir)) return 0;
    
    let cleaned = 0;
    const now = Date.now();

    try {
      const entries = await fs.promises.readdir(this.tempDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirPath = path.join(this.tempDir, entry.name);
          const stats = await fs.promises.stat(dirPath);
          if (now - stats.mtimeMs > maxAgeMs) {
            await fs.promises.rm(dirPath, { recursive: true, force: true });
            cleaned++;
            Logger.info(`CleanupService: Removed expired temp dir: ${entry.name}`);
          }
        }
      }
    } catch (err: any) {
      Logger.error('CleanupService: Error cleaning temp directories', err.message);
    }
    return cleaned;
  }

  // Clean up orphaned raw uploads older than 24 hours that were never processed or failed
  async cleanOrphanedUploads(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<number> {
    if (!fs.existsSync(this.rawUploadDir)) return 0;

    let cleaned = 0;
    const now = Date.now();

    try {
      const entries = await fs.promises.readdir(this.rawUploadDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const videoId = entry.name;
          const video = await dbService.getVideo(videoId);
          
          // If video record doesn't exist, or status is FAILED/COMPLETED and > maxAge
          const folderPath = path.join(this.rawUploadDir, videoId);
          const stats = await fs.promises.stat(folderPath);

          const isExpired = (now - stats.mtimeMs) > maxAgeMs;
          const shouldDelete = !video || (isExpired && video.status === VideoStatus.FAILED);

          if (shouldDelete) {
            await fs.promises.rm(folderPath, { recursive: true, force: true });
            cleaned++;
            Logger.info(`CleanupService: Removed orphaned raw upload folder for video: ${videoId}`);
          }
        }
      }
    } catch (err: any) {
      Logger.error('CleanupService: Error cleaning orphaned raw uploads', err.message);
    }
    return cleaned;
  }

  // Start periodic cleanup timer (runs every 6 hours)
  startPeriodicCleanup(intervalMs: number = 6 * 60 * 60 * 1000) {
    setInterval(() => {
      this.cleanTempDirectories();
      this.cleanOrphanedUploads();
    }, intervalMs);
    Logger.info('CleanupService: Periodic file cleanup scheduled (every 6 hours)');
  }
}

export const cleanupService = new CleanupService();
