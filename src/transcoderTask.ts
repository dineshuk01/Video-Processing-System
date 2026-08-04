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

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    Logger.info(`FFmpeg: Executing command -> ${ffmpegBin} ${args.join(' ')}`);
    const proc = spawn(ffmpegBin, args);
    let stderr = '';

    proc.on('error', (err) => {
      reject(new Error(`Failed to start FFmpeg: ${err.message}`));
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`FFmpeg exited with non-zero code ${code}. Error: ${stderr.slice(-300).trim()}`)
        );
      }
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

    // Update state to PROCESSING - 5%
    await dbService.updateVideo(videoId, {
      status: VideoStatus.PROCESSING,
      progress: 5,
    });

    // Step B2: Probe source video with FFprobe
    let metadata: VideoMetadata;
    try {
      metadata = await probeVideo(inputFilePath);
    } catch (probeErr: any) {
      Logger.warn(`FFprobe analysis failed, using defaults: ${probeErr.message}`);
      metadata = { width: 1920, height: 1080, duration: 0, codec: 'unknown', fps: 30 };
    }

    // Save metadata to DB
    await dbService.updateVideo(videoId, { metadata, progress: 8 });

    // Step C: Determine which HLS variants to generate (Smart Resolution Scaling)
    const sourceHeight = metadata.height;
    const eligibleVariants = HLS_VARIANTS.filter((v) => v.height <= sourceHeight);

    if (eligibleVariants.length === 0) {
      // Source is extremely small — generate at least 360p
      eligibleVariants.push(HLS_VARIANTS[0]);
    }

    Logger.info(`Transcoder Task: Source resolution ${metadata.width}x${sourceHeight}. Generating ${eligibleVariants.length} HLS variant(s): ${eligibleVariants.map(v => v.label).join(', ')}`);

    const gopSize = Math.round((metadata.fps || 30) * 6);
    const watermarkPath = path.join(localDataDir, 'watermark.png');
    const hasWatermark = fs.existsSync(watermarkPath);
    if (hasWatermark) {
      Logger.info(`Transcoder Task: Watermark image found at ${watermarkPath}. Overlaying on video.`);
    }

    // Step D: Transcode eligible HLS Resolutions
    const progressPerVariant = 70 / eligibleVariants.length; // Distribute 10% → 80% across variants
    let currentProgress = 10;

    for (const variant of eligibleVariants) {
      Logger.info(`Transcoder Task: Generating ${variant.label} HLS playlist...`);
      const ffmpegArgs = ['-y', '-i', inputFilePath];
      
      if (hasWatermark) {
        ffmpegArgs.push('-i', watermarkPath);
        ffmpegArgs.push(
          '-filter_complex',
          `[1:v]scale=64:-1[watermark];[0:v]scale=${variant.width}:${variant.height}[video];[video][watermark]overlay=W-w-10:10`
        );
      } else {
        ffmpegArgs.push('-vf', `scale=w=${variant.width}:h=${variant.height}`);
      }

      ffmpegArgs.push(
        '-c:v', 'libx264',
        '-b:v', variant.videoBitrate,
        '-c:a', 'aac',
        '-b:a', variant.audioBitrate,
        '-g', gopSize.toString(),
        '-keyint_min', gopSize.toString(),
        '-sc_threshold', '0',
        '-hls_time', '6',
        '-hls_playlist_type', 'vod',
        '-hls_segment_filename', path.join(outputDir, `output_${variant.label}_%03d.ts`),
        path.join(outputDir, `playlist_${variant.label}.m3u8`)
      );

      await runFfmpeg(ffmpegArgs);
      currentProgress += progressPerVariant;
      await dbService.updateVideo(videoId, { progress: Math.round(currentProgress) });
    }

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

    // Step E2: Write WebVTT Subtitle Track
    Logger.info(`Transcoder Task: Generating subtitle track files...`);
    const subtitleFileName = 'subtitles_en.vtt';
    const subtitleContent = `WEBVTT

00:00:00.000 --> 00:00:02.500
[VideoFlow CC] Welcome to VideoFlow adaptive player!

00:00:02.500 --> 00:00:05.500
This adaptive stream has been aligned with standard GOP keyframes.

00:00:05.500 --> 00:00:08.000
Enjoy smooth resolution switching and clear captions!
`;
    const subtitlePath = path.join(outputDir, subtitleFileName);
    await fs.promises.writeFile(subtitlePath, subtitleContent, 'utf8');
    await dbService.updateVideo(videoId, { progress: 86 });

    // Step F: Write Master manifest (progress 91%)
    Logger.info(`Transcoder Task: Writing master HLS playlist manifest...`);
    let masterPlaylistContent = '#EXTM3U\n#EXT-X-VERSION:3\n';
    
    // Add subtitles declaration
    masterPlaylistContent += `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,LANGUAGE="en",URI="${subtitleFileName}"\n`;
    
    for (const variant of eligibleVariants) {
      masterPlaylistContent += `#EXT-X-STREAM-INF:BANDWIDTH=${variant.bandwidth},RESOLUTION=${variant.width}x${variant.height},SUBTITLES="subs"\n`;
      masterPlaylistContent += `playlist_${variant.label}.m3u8\n`;
    }

    const masterPlaylistPath = path.join(outputDir, 'master.m3u8');
    await fs.promises.writeFile(masterPlaylistPath, masterPlaylistContent, 'utf8');
    await dbService.updateVideo(videoId, { progress: 91 });

    // Step G: Upload Playlist Directory & Poster (progress 97%)
    Logger.info(`Transcoder Task: Uploading generated HLS files & poster to ${outputBucket}/${outputKeyPrefix}`);
    const files = await fs.promises.readdir(outputDir);
    
    for (const file of files) {
      const filePath = path.join(outputDir, file);
      const fileKey = `${outputKeyPrefix}/${file}`;
      await storage.uploadFile(outputBucket, fileKey, filePath);
    }
    await dbService.updateVideo(videoId, { progress: 97 });

    // Step H: Cleanup Local Temp directories & set COMPLETED
    Logger.info('Transcoder Task: Cleaning up local temporary transcode files...');
    if (fs.existsSync(tempDir)) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }

    const port = process.env.PORT || 5000;

    // Build HLS playlist URL (CDN or local)
    let hlsPlaylistUrl: string;
    if (process.env.CDN_BASE_URL) {
      hlsPlaylistUrl = `${process.env.CDN_BASE_URL}/${outputKeyPrefix}/master.m3u8`;
    } else if (process.env.PROVIDER === 'aws') {
      hlsPlaylistUrl = `https://${outputBucket}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${outputKeyPrefix}/master.m3u8`;
    } else {
      hlsPlaylistUrl = `http://localhost:${port}/api/local-s3/${outputBucket}/${outputKeyPrefix}/master.m3u8`;
    }

    // Build poster thumbnail URL
    let thumbnailUrl: string | undefined;
    if (fs.existsSync(posterPath) || files.includes('poster.jpg')) {
      if (process.env.CDN_BASE_URL) {
        thumbnailUrl = `${process.env.CDN_BASE_URL}/${outputKeyPrefix}/poster.jpg`;
      } else if (process.env.PROVIDER === 'aws') {
        thumbnailUrl = `https://${outputBucket}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${outputKeyPrefix}/poster.jpg`;
      } else {
        thumbnailUrl = `http://localhost:${port}/api/local-s3/${outputBucket}/${outputKeyPrefix}/poster.jpg`;
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
        subtitleUrl = `http://localhost:${port}/api/local-s3/${outputBucket}/${outputKeyPrefix}/${subtitleFileName}`;
      }
    }

    await dbService.updateVideo(videoId, {
      status: VideoStatus.COMPLETED,
      progress: 100,
      hlsPlaylistUrl,
      thumbnailUrl,
      subtitleUrl,
    });
    Logger.info(`Transcoder Task: Video ${videoId} successfully transcoded and uploaded!`);
  } catch (err: any) {
    Logger.error(`Transcoder Task: Failed to transcode video ${videoId}`, err.message);

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
