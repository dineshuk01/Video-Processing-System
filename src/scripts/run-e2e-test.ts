import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import ffmpegPath from 'ffmpeg-static';

const API_URL = 'http://localhost:5000/api';
const TEMP_DIR = path.resolve(__dirname, '../../data/e2e-temp');

async function runE2ETest() {
  console.log('🚀 Starting End-to-End Integration Test\n');

  try {
    // 1. Setup Temp Directory
    if (!fs.existsSync(TEMP_DIR)) {
      fs.mkdirSync(TEMP_DIR, { recursive: true });
    }

    // 2. Generate Synthetic Test Video (3 seconds)
    const testVideoPath = path.join(TEMP_DIR, 'test_video.mp4');
    console.log('1️⃣  Generating synthetic test video (3s)...');
    execSync(
      `"${ffmpegPath}" -y -f lavfi -i testsrc=duration=3:size=640x360:rate=30 -f lavfi -i sine=frequency=1000:duration=3 -c:v libx264 -c:a aac "${testVideoPath}"`,
      { stdio: 'ignore' }
    );
    const fileSize = fs.statSync(testVideoPath).size;
    console.log(`✅ Test video generated: ${fileSize} bytes\n`);

    // 3. Initiate Upload
    console.log('2️⃣  Initiating upload...');
    const initRes = await fetch(`${API_URL}/upload/initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'e2e_test_video.mp4',
        contentType: 'video/mp4',
        fileSize: fileSize,
      })
    });
    const initData = await initRes.json() as any;
    if (!initRes.ok) throw new Error(`Init failed: ${JSON.stringify(initData)}`);
    const { videoId, uploadUrl } = initData.data;
    console.log(`✅ Upload initiated. Video ID: ${videoId}\n`);

    // 4. Upload File
    console.log(`3️⃣  Uploading file to mock S3 (PUT ${uploadUrl})...`);
    
    // Read file into buffer for fetch (since fetch in Node handles buffers well)
    const fileBuffer = fs.readFileSync(testVideoPath);
    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': fileSize.toString(),
      },
      body: fileBuffer,
    });
    if (!uploadRes.ok) throw new Error(`Upload failed with status ${uploadRes.status}`);
    console.log('✅ File uploaded successfully.\n');

    // 5. Complete Upload
    console.log('4️⃣  Completing upload...');
    const completeRes = await fetch(`${API_URL}/upload/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId })
    });
    const completeData = await completeRes.json() as any;
    if (!completeRes.ok) throw new Error(`Complete failed: ${JSON.stringify(completeData)}`);
    console.log('✅ Upload completed. Job queued.\n');

    // 6. Poll for Completion
    console.log('5️⃣  Polling for transcoding completion...');
    let isComplete = false;
    let attempts = 0;
    while (!isComplete && attempts < 30) {
      const statusRes = await fetch(`${API_URL}/videos/${videoId}`);
      const statusData = await statusRes.json() as any;
      if (!statusRes.ok) throw new Error(`Status check failed: ${JSON.stringify(statusData)}`);
      
      const status = statusData.data.status;
      const progress = statusData.data.progress;
      
      process.stdout.write(`\r   Status: ${status} | Progress: ${progress}%    `);
      
      if (status === 'COMPLETED') {
        isComplete = true;
        console.log('\n✅ Transcoding COMPLETED.\n');
        break;
      }
      if (status === 'FAILED') {
        console.log(`\n❌ Transcoding FAILED. Error: ${statusData.data.error}\n`);
        process.exit(1);
      }
      
      await new Promise(res => setTimeout(res, 2000));
      attempts++;
    }

    if (!isComplete) {
      console.log('\n❌ Timeout waiting for transcoder to complete.\n');
      process.exit(1);
    }

    // 7. Assert Output Files Exist
    console.log('6️⃣  Verifying generated output files...');
    const processedDir = path.resolve(__dirname, `../../data/s3-public/processed/${videoId}`);
    const requiredFiles = [
      'master.m3u8',
      'playlist_360p.m3u8',
      'playlist_1080p.m3u8',
      'poster.jpg'
    ];

    for (const file of requiredFiles) {
      const filePath = path.join(processedDir, file);
      if (!fs.existsSync(filePath)) {
        console.log(`❌ Missing required file: ${file}`);
        process.exit(1);
      }
    }
    console.log('✅ All required HLS playlists and poster image exist.\n');

    // 8. Delete Video & Cleanup
    console.log(`7️⃣  Cleaning up (DELETE /api/videos/${videoId})...`);
    const delRes = await fetch(`${API_URL}/videos/${videoId}`, { method: 'DELETE' });
    const delData = await delRes.json() as any;
    if (!delRes.ok) throw new Error(`Delete failed: ${JSON.stringify(delData)}`);
    
    // Check if files are deleted
    const rawDir = path.resolve(__dirname, `../../data/s3-temp/raw/${videoId}`);
    if (fs.existsSync(rawDir) || fs.existsSync(processedDir)) {
      console.log('❌ Cleanup failed. Files still exist on disk.');
      process.exit(1);
    }
    console.log('✅ Video record and all files successfully deleted.\n');

    console.log('🎉 E2E Test Passed Successfully!');

  } catch (err: any) {
    console.log('\n❌ E2E Test Failed:');
    console.log(err.message);
    process.exit(1);
  } finally {
    if (fs.existsSync(TEMP_DIR)) {
      fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    }
  }
}

runE2ETest();
