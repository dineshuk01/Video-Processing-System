import * as fs from 'fs';
import * as path from 'path';
import { getStorageService } from '../storage/storageService';
import { publicBucketName } from '../storage/publicUrl';
import { HttpError } from '../../utils/responseHandler';
import { Logger } from '../../utils/logger';

export const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;

// Subtitle files come in as SRT or WebVTT, in UTF-8 (or UTF-16 with a byte-order mark). Browsers only read
// WebVTT, so SRT is converted: "00:00:01,500" becomes "00:00:01.500" and the WEBVTT header is added.
export function toVtt(raw: Buffer): string {
  let text: string;
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) text = raw.subarray(2).toString('utf16le');
  else if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) text = Buffer.from(raw.subarray(2)).swap16().toString('utf16le');
  else text = raw.toString('utf8');
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (text.includes('\u0000')) throw new HttpError('That does not look like a subtitle file', 422, 'BAD_SUBTITLE');

  if (/^WEBVTT/.test(text)) return text + '\n';

  const cue = /(\d{1,2}:)?\d{2}:\d{2}[,.]\d{3}\s*-->\s*(\d{1,2}:)?\d{2}:\d{2}[,.]\d{3}/;
  if (!cue.test(text)) {
    throw new HttpError('Could not find any subtitle lines. Use an .srt or .vtt file.', 422, 'BAD_SUBTITLE');
  }
  const body = text
    .split('\n')
    .map((line) => (cue.test(line) ? line.replace(/(\d{2}),(\d{3})/g, '$1.$2') : line))
    .join('\n');
  return `WEBVTT\n\n${body}\n`;
}

// Stored under subtitles/<video id>/ (not processed/), so reprocessing a video does not erase them
export async function storeSubtitle(videoId: string, trackId: string, vtt: string): Promise<string> {
  const key = `subtitles/${videoId}/${trackId}-${Date.now()}.vtt`;
  const dir = path.join(path.resolve(process.env.LOCAL_DATA_DIR || './data'), 'temp', 'subs');
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.vtt`);
  await fs.promises.writeFile(tmp, vtt, 'utf8');
  try {
    await getStorageService().uploadFile(publicBucketName(), key, tmp);
  } finally {
    await fs.promises.unlink(tmp).catch(() => {});
  }
  return key;
}

export async function removeSubtitle(key?: string): Promise<void> {
  if (!key || !key.startsWith('subtitles/')) return; // embedded tracks live with the processed files
  try {
    await getStorageService().deleteObject(publicBucketName(), key);
  } catch (err: any) {
    Logger.warn(`Could not delete subtitle ${key}`, err.message);
  }
}

export async function removeAllSubtitles(videoId: string): Promise<void> {
  try {
    await getStorageService().deleteDirectory(publicBucketName(), `subtitles/${videoId}`);
  } catch (err: any) {
    Logger.warn(`Could not delete subtitles of ${videoId}`, err.message);
  }
}
