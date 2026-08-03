import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

import { VideoStatus } from './types';
import { dbService } from './services/db/dbService';
import { getStorageService } from './services/storage/storageService';
import { Logger } from './utils/logger';

// 1. Retrieve & Validate Task Parameters
// Non-null assertions are safe: the guard below calls process.exit(1) if any are falsy.
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

// Determine FFmpeg binary path (uses static binary in development, global binary in Docker Fargate)
let ffmpegBin = 'ffmpeg';
try {
  const staticFfmpegPath = require('ffmpeg-static');
  if (staticFfmpegPath) {
    ffmpegBin = staticFfmpegPath;
  }
} catch (err) {
  Logger.info('FFmpeg Static not resolved, falling back to global ffmpeg command');
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    Logger.info(`FFmpeg: Executing command -> ${ffmpegBin} ${args.join(' ')}`);
    const proc = spawn(ffmpegBin, args);
    let stderr = '';

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

    // Step C: Transcode HLS Resolutions
    
    // 1. Transcode 360p (progress 25%)
    Logger.info(`Transcoder Task: Generating 360p HLS playlist...`);
    await runFfmpeg([
      '-y',
      '-i', inputFilePath,
      '-vf', 'scale=w=640:h=360',
      '-c:v', 'libx264',
      '-b:v', '400k',
      '-c:a', 'aac',
      '-b:a', '64k',
      '-hls_time', '6',
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(outputDir, 'output_360p_%03d.ts'),
      path.join(outputDir, 'playlist_360p.m3u8'),
    ]);
    await dbService.updateVideo(videoId, { progress: 25 });

    // 2. Transcode 480p (progress 50%)
    Logger.info(`Transcoder Task: Generating 480p HLS playlist...`);
    await runFfmpeg([
      '-y',
      '-i', inputFilePath,
      '-vf', 'scale=w=854:h=480',
      '-c:v', 'libx264',
      '-b:v', '800k',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-hls_time', '6',
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(outputDir, 'output_480p_%03d.ts'),
      path.join(outputDir, 'playlist_480p.m3u8'),
    ]);
    await dbService.updateVideo(videoId, { progress: 50 });

    // 3. Transcode 720p (progress 70%)
    Logger.info(`Transcoder Task: Generating 720p HLS playlist...`);
    await runFfmpeg([
      '-y',
      '-i', inputFilePath,
      '-vf', 'scale=w=1280:h=720',
      '-c:v', 'libx264',
      '-b:v', '2500k',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-hls_time', '6',
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(outputDir, 'output_720p_%03d.ts'),
      path.join(outputDir, 'playlist_720p.m3u8'),
    ]);
    await dbService.updateVideo(videoId, { progress: 70 });

    // 4. Transcode 1080p (progress 90%)
    Logger.info(`Transcoder Task: Generating 1080p HLS playlist...`);
    await runFfmpeg([
      '-y',
      '-i', inputFilePath,
      '-vf', 'scale=w=1920:h=1080',
      '-c:v', 'libx264',
      '-b:v', '4500k',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-hls_time', '6',
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(outputDir, 'output_1080p_%03d.ts'),
      path.join(outputDir, 'playlist_1080p.m3u8'),
    ]);
    await dbService.updateVideo(videoId, { progress: 90 });

    // Step D: Extract Thumbnail Poster Frame (progress 91%)
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
    await dbService.updateVideo(videoId, { progress: 91 });

    // Step E: Write Master manifest (progress 93%)
    Logger.info(`Transcoder Task: Writing master HLS playlist manifest...`);
    const masterPlaylistContent = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x360
playlist_360p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480
playlist_480p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720
playlist_720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4500000,RESOLUTION=1920x1080
playlist_1080p.m3u8
`;
    const masterPlaylistPath = path.join(outputDir, 'master.m3u8');
    await fs.promises.writeFile(masterPlaylistPath, masterPlaylistContent, 'utf8');
    await dbService.updateVideo(videoId, { progress: 93 });

    // Step F: Upload Playlist Directory & Poster (progress 97%)
    Logger.info(`Transcoder Task: Uploading generated HLS files & poster to ${outputBucket}/${outputKeyPrefix}`);
    const files = await fs.promises.readdir(outputDir);
    
    for (const file of files) {
      const filePath = path.join(outputDir, file);
      const fileKey = `${outputKeyPrefix}/${file}`;
      await storage.uploadFile(outputBucket, fileKey, filePath);
    }
    await dbService.updateVideo(videoId, { progress: 97 });

    // Step G: Cleanup Local Temp directories & set COMPLETED
    Logger.info('Transcoder Task: Cleaning up local temporary transcode files...');
    if (fs.existsSync(tempDir)) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }

    const port = process.env.PORT || 5000;
    const hlsPlaylistUrl =
      process.env.PROVIDER === 'aws'
        ? `https://${outputBucket}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${outputKeyPrefix}/master.m3u8`
        : `http://localhost:${port}/api/local-s3/${outputBucket}/${outputKeyPrefix}/master.m3u8`;

    const thumbnailUrl = fs.existsSync(posterPath) || files.includes('poster.jpg')
      ? (process.env.PROVIDER === 'aws'
          ? `https://${outputBucket}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${outputKeyPrefix}/poster.jpg`
          : `http://localhost:${port}/api/local-s3/${outputBucket}/${outputKeyPrefix}/poster.jpg`)
      : undefined;

    await dbService.updateVideo(videoId, {
      status: VideoStatus.COMPLETED,
      progress: 100,
      hlsPlaylistUrl,
      thumbnailUrl,
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
