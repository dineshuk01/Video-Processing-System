import * as fs from 'fs';
import * as path from 'path';
import { StorageService } from './storageService';

export class LocalStorage implements StorageService {
  private dataDir: string;

  constructor() {
    this.dataDir = path.resolve(process.env.LOCAL_DATA_DIR || './data');
    this.ensureDir(this.dataDir);
  }

  private ensureDir(dirPath: string) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  private getBucketPath(bucket: string): string {
    const bucketPath = path.join(this.dataDir, bucket);
    this.ensureDir(bucketPath);
    return bucketPath;
  }

  async getSignedUrl(bucket: string, key: string, operation: 'upload' | 'download'): Promise<string> {
    // Relative by default so it works from whatever host the browser used; PUBLIC_BASE_URL overrides
    const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
    const normalizedKey = key.replace(/\\/g, '/');
    return `${base}/api/local-s3/${bucket}/${normalizedKey}?operation=${operation}`;
  }

  async uploadFile(bucket: string, key: string, filePath: string): Promise<void> {
    const bucketPath = this.getBucketPath(bucket);
    const destPath = path.join(bucketPath, key);
    
    this.ensureDir(path.dirname(destPath));
    await fs.promises.copyFile(filePath, destPath);
  }

  async downloadFile(bucket: string, key: string, destPath: string): Promise<void> {
    const bucketPath = this.getBucketPath(bucket);
    const sourcePath = path.join(bucketPath, key);
    
    try {
      await fs.promises.access(sourcePath, fs.constants.R_OK);
    } catch {
      throw new Error(`File not readable or not found in local mock S3 storage: ${bucket}/${key}`);
    }

    this.ensureDir(path.dirname(destPath));
    await fs.promises.copyFile(sourcePath, destPath);
  }

  async fileExists(bucket: string, key: string): Promise<boolean> {
    const bucketPath = this.getBucketPath(bucket);
    const filePath = path.join(bucketPath, key);
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    const bucketPath = this.getBucketPath(bucket);
    const filePath = path.join(bucketPath, key);
    try {
      await fs.promises.unlink(filePath);
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }
  }

  async deleteDirectory(bucket: string, prefix: string): Promise<void> {
    const bucketPath = this.getBucketPath(bucket);
    const dirPath = path.join(bucketPath, prefix);
    try {
      await fs.promises.rm(dirPath, { recursive: true, force: true });
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
    }
  }

  async getObjectMetadata(bucket: string, key: string): Promise<{ size: number; contentType?: string }> {
    const bucketPath = this.getBucketPath(bucket);
    const filePath = path.join(bucketPath, key);
    
    try {
      const stats = await fs.promises.stat(filePath);
      const ext = path.extname(filePath).toLowerCase();
      
      let contentType = 'application/octet-stream';
      if (ext === '.mp4') contentType = 'video/mp4';
      else if (ext === '.mkv') contentType = 'video/x-matroska';
      else if (ext === '.avi') contentType = 'video/x-msvideo';
      else if (ext === '.mov') contentType = 'video/quicktime';
      else if (ext === '.m3u8') contentType = 'application/x-mpegURL';
      else if (ext === '.ts') contentType = 'video/MP2T';
      else if (ext === '.txt') contentType = 'text/plain';

      return {
        size: stats.size,
        contentType,
      };
    } catch (err: any) {
      throw new Error(`Failed to get metadata for local file ${bucket}/${key}: ${err.message}`);
    }
  }
}
