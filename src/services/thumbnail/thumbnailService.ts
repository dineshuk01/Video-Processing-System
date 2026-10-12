import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { getStorageService } from '../storage/storageService';
import { publicBucketName } from '../storage/publicUrl';
import { HttpError } from '../../utils/responseHandler';
import { Logger } from '../../utils/logger';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function ffmpegBin(): string {
  try { return require('ffmpeg-static') || 'ffmpeg'; } catch { return 'ffmpeg'; }
}

// Decide what an upload really is from its first bytes; the Content-Type header is not trusted
export function sniffImage(buf: Buffer): 'jpg' | 'png' | 'webp' | null {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

function tmpDir(): string {
  const dir = path.join(path.resolve(process.env.LOCAL_DATA_DIR || './data'), 'temp', 'thumbs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const tmpName = (ext: string) => path.join(tmpDir(), `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin(), args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => reject(new Error(`Could not start FFmpeg: ${err.message}`)));
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-200).trim() || `FFmpeg exited with code ${code}`))));
  });
}

// Thumbnails are stored as JPEGs no wider than 1280 px, so every format shows up the same everywhere
const SCALE = "scale='min(1280,iw)':-2";

export async function imageToJpeg(image: Buffer): Promise<string> {
  const kind = sniffImage(image);
  if (!kind) throw new HttpError('Choose a JPEG, PNG or WebP image', 415, 'UNSUPPORTED_IMAGE');
  const input = tmpName(kind);
  const output = tmpName('jpg');
  await fs.promises.writeFile(input, image);
  try {
    await runFfmpeg(['-y', '-nostdin', '-i', input, '-frames:v', '1', '-vf', SCALE, '-q:v', '3', output]);
  } catch (err: any) {
    throw new HttpError(`That image could not be read: ${err.message}`, 422, 'BAD_IMAGE');
  } finally {
    await fs.promises.unlink(input).catch(() => {});
  }
  return output;
}

// `input` is a file path or a (presigned) URL; -ss before -i seeks without decoding everything before it
export async function frameToJpeg(input: string, seconds: number): Promise<string> {
  const output = tmpName('jpg');
  try {
    await runFfmpeg(['-y', '-nostdin', '-ss', String(seconds), '-i', input, '-frames:v', '1', '-vf', SCALE, '-q:v', '2', output]);
  } catch (err: any) {
    throw new HttpError(`Could not read a frame from the video: ${err.message}`, 422, 'BAD_FRAME');
  }
  if (!fs.existsSync(output) || fs.statSync(output).size === 0) {
    throw new HttpError('There is no frame at that position', 422, 'NO_FRAME');
  }
  return output;
}

// A new file name every time defeats browser/CDN caching of the old picture
export async function storeThumbnail(ownerId: string, jpgPath: string): Promise<string> {
  const key = `thumbnails/${ownerId}/thumb-${Date.now()}.jpg`;
  try {
    await getStorageService().uploadFile(publicBucketName(), key, jpgPath);
  } finally {
    await fs.promises.unlink(jpgPath).catch(() => {});
  }
  return key;
}

export async function removeThumbnail(key?: string): Promise<void> {
  if (!key) return;
  try {
    await getStorageService().deleteObject(publicBucketName(), key);
  } catch (err: any) {
    Logger.warn(`Could not delete old thumbnail ${key}`, err.message);
  }
}

export async function removeAllThumbnails(ownerId: string): Promise<void> {
  try {
    await getStorageService().deleteDirectory(publicBucketName(), `thumbnails/${ownerId}`);
  } catch (err: any) {
    Logger.warn(`Could not delete thumbnails of ${ownerId}`, err.message);
  }
}
