import { Router, Request, Response, NextFunction } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../utils/logger';
import { ResponseHandler } from '../utils/responseHandler';
import { isAdminRequest } from '../middleware/adminAuth';
import { dbService } from '../services/db/dbService';
import { videoService } from '../services/video/videoService';
import { seriesService } from '../services/series/seriesService';
import { getPublishedCache, setPublishedCache } from '../services/video/publishedCache';

const router = Router();

async function isPublishedVideo(id: string): Promise<boolean> {
  const cached = getPublishedCache(id);
  if (cached !== undefined) return cached;
  let ok: boolean;
  if (id.startsWith('series_')) {
    // A series poster is public while the series is published
    const series = await seriesService.get(id.slice('series_'.length));
    ok = !!series && series.published;
  } else {
    const video = await dbService.getVideo(id);
    ok = !!video && (await videoService.isVisible(video));
  }
  setPublishedCache(id, ok);
  return ok;
}

const maxUploadSizeBytes =
  parseInt(process.env.MAX_UPLOAD_SIZE_MB || '100', 10) * 1024 * 1024;

const allowedMimeTypes = (
  process.env.ALLOWED_MIME_TYPES || 'video/mp4,video/quicktime,video/x-matroska'
)
  .split(',')
  .map((m) => m.trim().toLowerCase());

router.put(
  '/:bucket/*',
  async (req: Request, res: Response, next: NextFunction) => {
    let destPath = '';
    try {
      // 1. Provider guard
      if (process.env.PROVIDER !== 'local') {
        req.resume();
        return ResponseHandler.error(
          res,
          'Mock S3 endpoint is only available when PROVIDER=local',
          403
        );
      }

      // Only admins upload (the local stand-in for a presigned S3 PUT)
      if (!isAdminRequest(req)) {
        req.resume();
        return ResponseHandler.error(res, 'Admin sign-in required', 401, 'UNAUTHORIZED');
      }

      const bucket = req.params.bucket;
      const key = req.params[0];

      if (!bucket || !key) {
        req.resume();
        return ResponseHandler.error(res, 'Missing bucket or object key', 400);
      }

      // 2. Validate content type
      const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!contentType || !allowedMimeTypes.includes(contentType)) {
        req.resume();
        return ResponseHandler.error(
          res,
          `Unsupported content-type: "${contentType}". Allowed: ${allowedMimeTypes.join(', ')}`,
          400
        );
      }

      // 3. Path safety check
      const dataDir = path.resolve(process.env.LOCAL_DATA_DIR || './data');
      destPath = path.join(dataDir, bucket, key);
      const relativePath = path.relative(path.join(dataDir, bucket), destPath);
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        req.resume();
        return ResponseHandler.error(res, 'Directory traversal detected', 400);
      }

      // 4. Ensure target directory exists
      fs.mkdirSync(path.dirname(destPath), { recursive: true });

      // 5. Stream request body to disk via pipe (backpressure-safe)
      const writeStream = fs.createWriteStream(destPath);
      let bytesWritten = 0;
      let limitExceeded = false;

      await new Promise<void>((resolve, reject) => {
        // Count bytes and enforce size limit
        req.on('data', (chunk: Buffer) => {
          bytesWritten += chunk.length;
          if (bytesWritten > maxUploadSizeBytes && !limitExceeded) {
            limitExceeded = true;
            req.unpipe(writeStream);
            req.destroy();
            writeStream.destroy();
            try { fs.unlinkSync(destPath); } catch {}
            reject(new Error(`Upload exceeds maximum size of ${process.env.MAX_UPLOAD_SIZE_MB || 100}MB`));
          }
        });

        req.on('error', (err) => {
          writeStream.destroy();
          try { fs.unlinkSync(destPath); } catch {}
          reject(err);
        });

        req.on('aborted', () => {
          writeStream.destroy();
          try { fs.unlinkSync(destPath); } catch {}
          reject(new Error('Upload request was aborted by the client'));
        });

        writeStream.on('error', (err) => {
          req.destroy();
          reject(err);
        });

        writeStream.on('finish', resolve);

        // pipe handles backpressure automatically
        req.pipe(writeStream);
      });

      if (limitExceeded) {
        return ResponseHandler.error(
          res,
          `File too large. Maximum allowed size is ${process.env.MAX_UPLOAD_SIZE_MB || 100}MB`,
          413
        );
      }

      Logger.info(`Mock S3 Upload success: bucket=${bucket}, key=${key}, size=${bytesWritten} bytes`);
      return ResponseHandler.success(res, { message: 'Upload successful' }, 200);
    } catch (err: any) {
      // Clean up partial file on unexpected errors
      if (destPath) {
        try { fs.unlinkSync(destPath); } catch {}
      }
      next(err);
    }
  }
);

// GET /api/local-s3/:bucket/* — Serve simulated S3 files (HLS playlists, video segments, raw files)
router.get(
  '/:bucket/*',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (process.env.PROVIDER !== 'local') {
        return ResponseHandler.error(
          res,
          'Mock S3 endpoint is only available when PROVIDER=local',
          403
        );
      }

      const bucket = req.params.bucket;
      const key = req.params[0];

      if (!bucket || !key) {
        return ResponseHandler.error(res, 'Missing bucket or object key', 400);
      }

      const dataDir = path.resolve(process.env.LOCAL_DATA_DIR || './data');
      const filePath = path.join(dataDir, bucket, key);

      // Prevent directory traversal
      const relativePath = path.relative(path.join(dataDir, bucket), filePath);
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return ResponseHandler.error(res, 'Directory traversal detected', 400);
      }

      // The public may only read the processed output of published videos. Raw uploads and
      // unpublished videos are admin-only, and look "not found" to everyone else.
      if (!isAdminRequest(req)) {
        const publicBucket = process.env.LOCAL_S3_PUBLIC_BUCKET;
        const match = bucket === publicBucket ? /^(?:processed|thumbnails)\/([^/]+)\//.exec(key) : null;
        if (!match || !(await isPublishedVideo(match[1]))) {
          return ResponseHandler.error(res, `Object ${key} not found in bucket ${bucket}`, 404);
        }
      }

      if (!fs.existsSync(filePath)) {
        return ResponseHandler.error(res, `Object ${key} not found in bucket ${bucket}`, 404);
      }

      // Determine Content-Type
      const ext = path.extname(filePath).toLowerCase();
      let contentType = 'application/octet-stream';
      if (ext === '.m3u8') contentType = 'application/x-mpegURL';
      else if (ext === '.ts') contentType = 'video/MP2T';
      else if (ext === '.vtt') contentType = 'text/vtt';
      else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
      else if (ext === '.png') contentType = 'image/png';
      else if (ext === '.mp4') contentType = 'video/mp4';
      else if (ext === '.mkv') contentType = 'video/x-matroska';
      else if (ext === '.mov') contentType = 'video/quicktime';

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('Content-Type', contentType);

      return res.sendFile(filePath);
    } catch (err: any) {
      next(err);
    }
  }
);

export default router;
