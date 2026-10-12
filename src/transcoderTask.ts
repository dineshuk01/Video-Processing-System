import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

import { VideoStatus, VideoMetadata } from './types';
import { dbService } from './services/db/dbService';
import { getStorageService } from './services/storage/storageService';
import { Logger } from './utils/logger';

// Processing log lines shown to admins. A logging failure must never fail the transcode.
const log = (level: 'info' | 'warn' | 'error', message: string) =>
  dbService.appendEvent(videoId, level, message).catch((err) => Logger.warn('Could not write job log', err.message));

// Base for media URLs served by this app in local mode. Empty means relative URLs, which
// work from any host. Set PUBLIC_BASE_URL only if the site is served from another origin.
const publicBase = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');

// 1. Retrieve & Validate Task Parameters
const videoId = process.env.VIDEO_ID!;
const inputBucket = process.env.INPUT_BUCKET!;
const inputKey = process.env.INPUT_KEY!;
const outputBucket = process.env.OUTPUT_BUCKET!;
const outputKeyPrefix = process.env.OUTPUT_KEY_PREFIX!;

if (!videoId || !inputBucket || !inputKey || !outputBucket || !outputKeyPrefix) {
  Logger.error('Transcoder Task: Missing required environment variables', {
    videoId,
    inputBucket,
    inputKey,
    outputBucket,
    outputKeyPrefix,
  });
  process.exit(1);
}

// Determine FFmpeg/FFprobe binary paths
let ffmpegBin = 'ffmpeg';
let ffprobeBin = 'ffprobe';

try {
  const staticFfmpegPath = require('ffmpeg-static');
  if (staticFfmpegPath) {
    ffmpegBin = staticFfmpegPath;
  }
} catch (err) {
  Logger.info('FFmpeg Static not resolved, falling back to global ffmpeg');
}

try {
  const staticFfprobePath = require('ffprobe-static');
  if (staticFfprobePath && staticFfprobePath.path) {
    ffprobeBin = staticFfprobePath.path;
  }
} catch (err) {
  Logger.info('FFprobe Static not resolved, falling back to global ffprobe');
}

// ─── HLS Resolution Ladder ────────────────────────────────────
interface HlsVariant {
  label: string;
  width: number;
  height: number;
  videoBitrate: string;
  audioBitrate: string;
  bandwidth: number;
}

const HLS_VARIANTS: HlsVariant[] = [
  { label: '360p',  width: 640,  height: 360,  videoBitrate: '400k',  audioBitrate: '64k',  bandwidth: 400000 },
  { label: '480p',  width: 854,  height: 480,  videoBitrate: '800k',  audioBitrate: '96k',  bandwidth: 800000 },
  { label: '720p',  width: 1280, height: 720,  videoBitrate: '2500k', audioBitrate: '128k', bandwidth: 2500000 },
  { label: '1080p', width: 1920, height: 1080, videoBitrate: '4500k', audioBitrate: '128k', bandwidth: 4500000 },
];

// An admin paused or deleted the video: stop quietly instead of failing or retrying
class AbortedError extends Error {}
const ABORT_EXIT_CODE = 3;
let started = false; // true once this task has marked the video PROCESSING

async function stopRequested(): Promise<boolean> {
  const record = await dbService.getVideo(videoId).catch(() => undefined);
  if (record === undefined) return false;                  // database hiccup: keep going
  if (record === null) return true;                        // the video was deleted
  if (record.status === VideoStatus.PAUSED) return true;   // paused
  // Reset to something else (e.g. paused, then resumed): a newer run owns the video now
  return started && record.status !== VideoStatus.PROCESSING;
}

async function assertNotStopped() {
  if (await stopRequested()) throw new AbortedError('Stopped by an admin');
}

// Presets trade speed for file size at the same quality. 'veryfast' is a good default for streaming.
const PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'];
const x264Preset = PRESETS.includes(process.env.FFMPEG_PRESET || '') ? process.env.FFMPEG_PRESET! : 'veryfast';

// `onTime` receives how many seconds of the video have been encoded so far (needs `-progress pipe:1`)
function runFfmpeg(args: string[], onTime?: (seconds: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    Logger.info(`FFmpeg: Executing command -> ${ffmpegBin} ${args.join(' ')}`);
    const proc = spawn(ffmpegBin, args);
    let stderr = '';
    let stopped = false;

    // Look for a pause/delete request while FFmpeg runs and kill it straight away
    const watcher = setInterval(async () => {
      if (!stopped && (await stopRequested())) {
        stopped = true;
        proc.kill('SIGKILL');
      }
    }, 1500);

    proc.on('error', (err) => {
      clearInterval(watcher);
      reject(new Error(`Failed to start FFmpeg: ${err.message}`));
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // -progress prints "key=value" lines; out_time_us is the encoded position in microseconds
    let outBuffer = '';
    if (onTime) {
      proc.stdout.on('data', (data) => {
        outBuffer += data.toString();
        const lines = outBuffer.split('\n');
        outBuffer = lines.pop() || '';
        for (const line of lines) {
          const match = /^out_time_(?:us|ms)=(\d+)/.exec(line.trim());
          if (match) onTime(Number(match[1]) / 1e6);
        }
      });
    }

    proc.on('close', (code) => {
      clearInterval(watcher);
      if (stopped) {
        reject(new AbortedError('Stopped by an admin'));
      } else if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`FFmpeg exited with non-zero code ${code}. Error: ${stderr.slice(-300).trim()}`)
        );
      }
    });
  });
}

// Time of the first audio packet, or null when there is no audio. Some files declare audio from 0 s
// but only carry it from much later (e.g. an intro with no sound track); the container does not say.
function probeAudioStart(filePath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn(ffprobeBin, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', '-read_intervals', '%+#1', filePath]);
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      const t = parseFloat(out.split(/\r?\n/)[0]);
      resolve(Number.isFinite(t) ? t : null);
    });
  });
}

// ─── FFprobe: Probe source video metadata ─────────────────────
function probeVideo(filePath: string): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    Logger.info(`FFprobe: Analyzing source video -> ${ffprobeBin}`);
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ];
    const proc = spawn(ffprobeBin, args);
    let stdout = '';
    let stderr = '';

    proc.on('error', (err) => {
      reject(new Error(`Failed to start FFprobe: ${err.message}`));
    });

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`FFprobe exited with code ${code}: ${stderr.slice(-200).trim()}`));
        return;
      }

      try {
        const info = JSON.parse(stdout);
        const videoStream = info.streams?.find((s: any) => s.codec_type === 'video');

        if (!videoStream) {
          reject(new Error('No video stream found in source file'));
          return;
        }

        // Parse frame rate from r_frame_rate (e.g. "30/1" or "24000/1001")
        let fps = 30;
        if (videoStream.r_frame_rate) {
          const parts = videoStream.r_frame_rate.split('/');
          fps = parts.length === 2 ? Math.round(parseInt(parts[0]) / parseInt(parts[1])) : parseInt(parts[0]);
        }

        const metadata: VideoMetadata = {
          width: videoStream.width || 0,
          height: videoStream.height || 0,
          duration: parseFloat(info.format?.duration || videoStream.duration || '0'),
          codec: videoStream.codec_name || 'unknown',
          fps,
          bitrate: info.format?.bit_rate ? Math.round(parseInt(info.format.bit_rate) / 1000) : undefined,
        };

        Logger.info(`FFprobe: Source video analysis complete`, metadata as any);
        resolve(metadata);
      } catch (parseErr: any) {
        reject(new Error(`Failed to parse FFprobe output: ${parseErr.message}`));
      }
    });
  });
}

async function executeTranscoding() {
  Logger.info(`Transcoder Task: Starting transcode pipeline for video ${videoId}`);

  const localDataDir = path.resolve(process.env.LOCAL_DATA_DIR || './data');
  const tempDir = path.join(localDataDir, 'temp', videoId);
  const inputFilePath = path.join(tempDir, 'input_raw' + path.extname(inputKey));
  const outputDir = path.join(tempDir, 'hls');

  try {
    // Step A: Setup Workspace Directories
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Step B: Download Raw Video
    Logger.info(`Transcoder Task: Downloading raw video ${inputBucket}/${inputKey}`);
    const storage = getStorageService();
    await storage.downloadFile(inputBucket, inputKey, inputFilePath);

    // Stop here if the video was paused or deleted while the source was downloading
    await assertNotStopped();

    // Update state to PROCESSING - 5%
    await dbService.updateVideo(videoId, {
      status: VideoStatus.PROCESSING,
      progress: 5,
    });
    started = true;

    await log('info', 'Source file downloaded');

    // Admin settings chosen for this video (quality ladder, auto-publish)
    const record = await dbService.getVideo(videoId);
    const selectedQualities = record?.qualities && record.qualities.length > 0 ? record.qualities : null;

    // Step B2: Probe source video with FFprobe
    let metadata: VideoMetadata;
    try {
      metadata = await probeVideo(inputFilePath);
    } catch (probeErr: any) {
      Logger.warn(`FFprobe analysis failed, using defaults: ${probeErr.message}`);
      await log('warn', `Could not read source details, using defaults: ${probeErr.message}`);
      metadata = { width: 1920, height: 1080, duration: 0, codec: 'unknown', fps: 30 };
    }

    // Save metadata to DB
    await dbService.updateVideo(videoId, { metadata, progress: 8 });
    await log('info', `Source: ${metadata.width}x${metadata.height}, ${metadata.codec}, ${metadata.fps} fps, ${metadata.duration.toFixed(1)}s`);

    // If the audio starts late, the HLS segments before it would have no audio at all, which browsers
    // cannot play ("bufferAppendError"). The encoder pads that stretch with silence instead (see -af below).
    const audioStart = await probeAudioStart(inputFilePath);
    if (audioStart !== null && audioStart > 0.5) {
      await log('warn', `The audio only starts ${audioStart.toFixed(1)} s into the video. Silence is added before it so the stream plays in every browser.`);
    }

    // Step C: Decide which renditions to make.
    const srcW = metadata.width || 1920;
    const srcH = metadata.height || 1080;
    const allowUpscale = !!record?.allowUpscale;

    // "720p" is a size class, not a literal height: a 1280-wide widescreen movie is 720p even though
    // it is only 536 px tall. A class is reached when the source is at least that wide or that tall.
    const reached = (v: HlsVariant) => srcW >= v.width * 0.98 || srcH >= v.height * 0.98;
    const wanted = HLS_VARIANTS.filter((v) => !selectedQualities || selectedQualities.includes(v.height));
    const eligibleVariants = wanted.filter((v) => allowUpscale || reached(v));
    const skipped = wanted.filter((v) => !eligibleVariants.includes(v));

    if (eligibleVariants.length === 0) {
      // Nothing selected fits the source (e.g. only 1080p chosen for a 480p video):
      // fall back to the smallest selected rendition, or 360p, so the video is still playable
      const fallback = selectedQualities
        ? HLS_VARIANTS.find((v) => v.height === Math.min(...selectedQualities)) || HLS_VARIANTS[0]
        : HLS_VARIANTS[0];
      eligibleVariants.push(fallback);
      await log('warn', `None of the selected qualities fit a ${srcW}x${srcH} source. Generating ${fallback.label} instead.`);
    } else if (skipped.length > 0) {
      await log('warn', `Skipped ${skipped.map((v) => v.label).join(', ')}: larger than the ${srcW}x${srcH} source. Turn on "Allow upscaling" in the video settings to create them anyway.`);
    }
    await log('info', `Generating renditions: ${eligibleVariants.map((v) => v.label).join(', ')}`);

    Logger.info(`Transcoder Task: Source resolution ${srcW}x${srcH}. Generating ${eligibleVariants.length} HLS variant(s): ${eligibleVariants.map(v => v.label).join(', ')}`);

    const gopSize = Math.round((metadata.fps || 30) * 6);
    const watermarkPath = path.join(localDataDir, 'watermark.png');
    const hasWatermark = fs.existsSync(watermarkPath);
    if (hasWatermark) {
      Logger.info(`Transcoder Task: Watermark image found at ${watermarkPath}. Overlaying on video.`);
    }

    // Output size: fit the rendition's 16:9 box while keeping the source's aspect ratio (a 2.39:1 movie
    // must not be stretched to 16:9), never above the source unless upscaling was asked for.
    // H.264 needs even dimensions.
    const aspect = srcW / srcH;
    const even = (x: number) => Math.max(2, Math.round(x / 2) * 2);
    const sizeOf = (v: HlsVariant) => {
      let w = v.width;
      let h = w / aspect;
      if (h > v.height) { h = v.height; w = h * aspect; }                  // taller than the box: fit by height
      if (!allowUpscale && (w > srcW || h > srcH)) { w = srcW; h = srcH; } // keep native size, no upscaling
      return { w: even(w), h: even(h), upscaled: w > srcW || h > srcH };
    };
    const sizes = new Map(eligibleVariants.map((v) => [v.label, sizeOf(v)] as const));

    // Step D: Transcode every rendition in a single FFmpeg run. The source is decoded once and
    // split into one scaled copy per rendition; decoding (especially HEVC) is a large share of the work.
    const n = eligibleVariants.length;
    const ffmpegArgs = ['-y', '-nostdin', '-i', inputFilePath];
    if (hasWatermark) ffmpegArgs.push('-i', watermarkPath);

    // Lanczos keeps upscaled frames as sharp as scaling can make them
    const scaleFilter = (v: HlsVariant) => {
      const size = sizes.get(v.label)!;
      return `scale=${size.w}:${size.h}${size.upscaled ? ':flags=lanczos' : ''}`;
    };
    const names = (prefix: string) => eligibleVariants.map((_, i) => `[${prefix}${i}]`).join('');
    let graph = `[0:v]split=${n}${names('v')}`;
    if (hasWatermark) graph += `;[1:v]scale=64:-1,split=${n}${names('w')}`;
    eligibleVariants.forEach((v, i) => {
      graph += hasWatermark
        ? `;[v${i}]${scaleFilter(v)}[s${i}];[s${i}][w${i}]overlay=W-w-10:10[o${i}]`
        : `;[v${i}]${scaleFilter(v)}[o${i}]`;
    });
    ffmpegArgs.push('-filter_complex', graph, '-progress', 'pipe:1', '-nostats');

    eligibleVariants.forEach((v, i) => {
      ffmpegArgs.push(
        '-map', `[o${i}]`, '-map', '0:a:0?',
        '-c:v', 'libx264',
        '-preset', x264Preset,
        '-pix_fmt', 'yuv420p', // 8-bit: browsers cannot play 10-bit H.264 ("High 10"), which 10-bit sources produce by default
        '-b:v', v.videoBitrate,
        '-af', 'aresample=async=1:first_pts=0', // silence from 0 s up to where the audio really starts
        '-c:a', 'aac',
        '-ac', '2',
        '-b:a', v.audioBitrate,
        '-g', gopSize.toString(),
        '-keyint_min', gopSize.toString(),
        '-sc_threshold', '0',
        '-hls_time', '6',
        '-hls_playlist_type', 'vod',
        '-hls_segment_filename', path.join(outputDir, `output_${v.label}_%03d.ts`),
        path.join(outputDir, `playlist_${v.label}.m3u8`)
      );
    });

    // Progress follows the encoded position, so long videos visibly advance (10% -> 80%)
    let lastProgressWrite = 0;
    let lastProgress = 10;
    let writingProgress = false;
    const onTime = (seconds: number) => {
      if (!metadata.duration || writingProgress || Date.now() - lastProgressWrite < 3000) return;
      const pct = Math.min(80, Math.round(10 + 70 * Math.min(1, seconds / metadata.duration)));
      if (pct === lastProgress) return;
      writingProgress = true;
      lastProgressWrite = Date.now();
      lastProgress = pct;
      dbService.updateVideo(videoId, { progress: pct })
        .catch(() => { /* a missed progress tick is harmless */ })
        .finally(() => { writingProgress = false; });
    };

    Logger.info(`Transcoder Task: Encoding ${n} rendition(s) in one pass (preset ${x264Preset})...`);
    await runFfmpeg(ffmpegArgs, onTime);
    await log('info', `Encoded ${eligibleVariants.map((v) => v.label).join(', ')} (preset ${x264Preset})`);
    await dbService.updateVideo(videoId, { progress: 80 });

    await assertNotStopped();

    // Step E: Extract Thumbnail Poster Frame (progress +2%)
    Logger.info(`Transcoder Task: Extracting poster frame thumbnail for video ${videoId}...`);
    const posterPath = path.join(outputDir, 'poster.jpg');
    try {
      await runFfmpeg([
        '-y',
        '-ss', '00:00:02',
        '-i', inputFilePath,
        '-vframes', '1',
        '-q:v', '2',
        posterPath,
      ]);
    } catch (posterErr: any) {
      Logger.warn('Poster frame extraction at 2s failed, falling back to 0s frame', posterErr.message);
      try {
        await runFfmpeg([
          '-y',
          '-i', inputFilePath,
          '-vframes', '1',
          '-q:v', '2',
          posterPath,
        ]);
      } catch {}
    }
    await dbService.updateVideo(videoId, { progress: 83 });

    // Step E2: Optional placeholder WebVTT track. Off by default: these are sample lines, not real
    // captions, so they must not appear on a public site unless someone deliberately turns them on.
    const subtitleFileName = 'subtitles_en.vtt';
    const subtitlePath = path.join(outputDir, subtitleFileName);
    if (process.env.ENABLE_PLACEHOLDER_CAPTIONS === 'true') {
    Logger.info(`Transcoder Task: Generating subtitle track files...`);
    const subtitleContent = `WEBVTT

00:00:00.000 --> 00:00:02.500
[VideoFlow CC] Welcome to VideoFlow adaptive player!

00:00:02.500 --> 00:00:05.500
This adaptive stream has been aligned with standard GOP keyframes.

00:00:05.500 --> 00:00:08.000
Enjoy smooth resolution switching and clear captions!
`;
    await fs.promises.writeFile(subtitlePath, subtitleContent, 'utf8');

    // Write subtitle HLS playlist (Hls.js requires subtitle tracks as .m3u8, not raw .vtt)
    const subtitlePlaylistName = 'subs_en.m3u8';
    const videoDuration = metadata.duration || 10;
    const subtitlePlaylistContent = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${Math.ceil(videoDuration)}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:${videoDuration.toFixed(6)},\n${subtitleFileName}\n#EXT-X-ENDLIST\n`;
    await fs.promises.writeFile(path.join(outputDir, subtitlePlaylistName), subtitlePlaylistContent, 'utf8');
    }

    await dbService.updateVideo(videoId, { progress: 86 });

    // Step F: Write Master manifest (progress 91%)
    Logger.info(`Transcoder Task: Writing master HLS playlist manifest...`);
    let masterPlaylistContent = '#EXTM3U\n#EXT-X-VERSION:3\n';
    
    for (const variant of eligibleVariants) {
      masterPlaylistContent += `#EXT-X-STREAM-INF:BANDWIDTH=${variant.bandwidth},RESOLUTION=${sizes.get(variant.label)!.w}x${sizes.get(variant.label)!.h}\n`;
      masterPlaylistContent += `playlist_${variant.label}.m3u8\n`;
    }

    const masterPlaylistPath = path.join(outputDir, 'master.m3u8');
    await fs.promises.writeFile(masterPlaylistPath, masterPlaylistContent, 'utf8');
    await dbService.updateVideo(videoId, { progress: 91 });

    // Step G: Upload Playlist Directory & Poster (progress 97%)
    Logger.info(`Transcoder Task: Uploading generated HLS files & poster to ${outputBucket}/${outputKeyPrefix}`);
    const files = await fs.promises.readdir(outputDir);
    
    for (const file of files) {
      await assertNotStopped();
      const filePath = path.join(outputDir, file);
      const fileKey = `${outputKeyPrefix}/${file}`;
      await storage.uploadFile(outputBucket, fileKey, filePath);
    }
    await dbService.updateVideo(videoId, { progress: 97 });
    await log('info', `Uploaded ${files.length} files to storage`);

    // Step H: Cleanup Local Temp directories & set COMPLETED
    Logger.info('Transcoder Task: Cleaning up local temporary transcode files...');
    if (fs.existsSync(tempDir)) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }

    // Build HLS playlist URL (CDN or local)
    let hlsPlaylistUrl: string;
    if (process.env.CDN_BASE_URL) {
      hlsPlaylistUrl = `${process.env.CDN_BASE_URL}/${outputKeyPrefix}/master.m3u8`;
    } else if (process.env.PROVIDER === 'aws') {
      hlsPlaylistUrl = `https://${outputBucket}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${outputKeyPrefix}/master.m3u8`;
    } else {
      hlsPlaylistUrl = `${publicBase}/api/local-s3/${outputBucket}/${outputKeyPrefix}/master.m3u8`;
    }

    // Build poster thumbnail URL
    let thumbnailUrl: string | undefined;
    if (fs.existsSync(posterPath) || files.includes('poster.jpg')) {
      if (process.env.CDN_BASE_URL) {
        thumbnailUrl = `${process.env.CDN_BASE_URL}/${outputKeyPrefix}/poster.jpg`;
      } else if (process.env.PROVIDER === 'aws') {
        thumbnailUrl = `https://${outputBucket}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${outputKeyPrefix}/poster.jpg`;
      } else {
        thumbnailUrl = `${publicBase}/api/local-s3/${outputBucket}/${outputKeyPrefix}/poster.jpg`;
      }
    }

    // Build subtitle URL
    let subtitleUrl: string | undefined;
    if (fs.existsSync(subtitlePath) || files.includes(subtitleFileName)) {
      if (process.env.CDN_BASE_URL) {
        subtitleUrl = `${process.env.CDN_BASE_URL}/${outputKeyPrefix}/${subtitleFileName}`;
      } else if (process.env.PROVIDER === 'aws') {
        subtitleUrl = `https://${outputBucket}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${outputKeyPrefix}/${subtitleFileName}`;
      } else {
        subtitleUrl = `${publicBase}/api/local-s3/${outputBucket}/${outputKeyPrefix}/${subtitleFileName}`;
      }
    }

    // A pause/delete that arrived during the upload must not be overwritten by "completed"
    await assertNotStopped();

    await dbService.updateVideo(videoId, {
      status: VideoStatus.COMPLETED,
      progress: 100,
      hlsPlaylistUrl,
      thumbnailUrl,
      subtitleUrl,
      renditions: eligibleVariants.map((v) => v.label),
      ...(record?.autoPublish ? { published: true } : {}),
    });
    await log('info', 'Processing complete');
    if (record?.autoPublish) await log('info', 'Published to the public site (auto-publish)');
    Logger.info(`Transcoder Task: Video ${videoId} successfully transcoded and uploaded!`);
  } catch (err: any) {
    if (err instanceof AbortedError) {
      Logger.info(`Transcoder Task: Video ${videoId} was paused or deleted. Stopping.`);
      try {
        if (fs.existsSync(tempDir)) await fs.promises.rm(tempDir, { recursive: true, force: true });
        // Remove any partial output that was already uploaded
        await getStorageService().deleteDirectory(outputBucket, outputKeyPrefix);
      } catch (cleanupErr: any) {
        Logger.warn('Could not fully clean up after stopping', cleanupErr.message);
      }
      await log('warn', 'Processing stopped by an admin');
      process.exit(ABORT_EXIT_CODE);
    }

    Logger.error(`Transcoder Task: Failed to transcode video ${videoId}`, err.message);
    await log('error', `Transcoding error: ${err.message}`);

    // Try to cleanup temp folders
    try {
      if (fs.existsSync(tempDir)) {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      }
    } catch {}

    // Update status to FAILED
    try {
      await dbService.updateVideo(videoId, {
        status: VideoStatus.FAILED,
        error: err.message || 'Transcoding error',
      });
    } catch {}

    process.exit(1);
  }
}

executeTranscoding();
