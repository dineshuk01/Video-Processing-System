import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

import { getStorageService } from '../services/storage/storageService';
import { getQueueService } from '../services/queue/queueService';

async function runVerification() {
  console.log('==================================================');
  console.log('   Video Processing System - Phase 1 Verification ');
  console.log('==================================================\n');

  const provider = process.env.PROVIDER || 'local';
  console.log(`[Config] Selected Service Provider: ${provider}`);
  console.log(`[Config] Local Data Directory: ${process.env.LOCAL_DATA_DIR || './data'}\n`);

  // 1. Verify and create directories
  console.log('1. Verifying Local Directories...');
  const dataDir = path.resolve(process.env.LOCAL_DATA_DIR || './data');
  const directories = [
    dataDir,
    path.join(dataDir, process.env.LOCAL_S3_TEMP_BUCKET || 's3-temp'),
    path.join(dataDir, process.env.LOCAL_S3_PUBLIC_BUCKET || 's3-public'),
    path.join(dataDir, 'queue')
  ];

  for (const dir of directories) {
    if (!fs.existsSync(dir)) {
      console.log(`   - Creating directory: ${dir}`);
      fs.mkdirSync(dir, { recursive: true });
    } else {
      console.log(`   - Directory exists: ${dir}`);
    }
  }
  console.log('   ✓ Directories verified.\n');

  // 2. Verify static FFmpeg installation
  console.log('2. Verifying Static FFmpeg Binary...');
  try {
    const ffmpegPath = require('ffmpeg-static');
    if (!ffmpegPath) {
      throw new Error('ffmpeg-static package returned null path');
    }
    console.log(`   - Found static FFmpeg binary at: ${ffmpegPath}`);
    
    await new Promise<void>((resolve, reject) => {
      execFile(ffmpegPath, ['-version'], (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const firstLine = stdout.split('\n')[0];
        console.log(`   - FFmpeg Version: ${firstLine}`);
        resolve();
      });
    });
    console.log('   ✓ FFmpeg binary verified.\n');
  } catch (err: any) {
    console.error('   ✗ FFmpeg verification FAILED:', err.message);
    process.exit(1);
  }

  // 3. Verify Storage Service Mock
  console.log('3. Verifying Storage Service (Mock/Local)...');
  try {
    const storage = getStorageService();
    const testBucket = process.env.LOCAL_S3_TEMP_BUCKET || 's3-temp';
    const testKey = 'verification/test-file.txt';
    const testContent = 'Verification test content ' + Date.now();
    
    // Create temporary file to upload
    const tempLocalFile = path.join(dataDir, 'temp-verify.txt');
    fs.writeFileSync(tempLocalFile, testContent);

    // Upload
    await storage.uploadFile(testBucket, testKey, tempLocalFile);
    console.log(`   - Uploaded file to mock S3: ${testBucket}/${testKey}`);

    // Presigned URL
    const uploadUrl = await storage.getSignedUrl(testBucket, testKey, 'upload');
    console.log(`   - Generated signed upload URL: ${uploadUrl}`);

    // Download
    const downloadDest = path.join(dataDir, 'temp-verify-downloaded.txt');
    await storage.downloadFile(testBucket, testKey, downloadDest);
    console.log(`   - Downloaded file from mock S3 to: ${downloadDest}`);

    // Verify content
    const downloadedContent = fs.readFileSync(downloadDest, 'utf8');
    if (downloadedContent !== testContent) {
      throw new Error('Downloaded file content does not match uploaded file content');
    }

    // Cleanup local temp verification files
    if (fs.existsSync(tempLocalFile)) fs.unlinkSync(tempLocalFile);
    if (fs.existsSync(downloadDest)) fs.unlinkSync(downloadDest);
    
    console.log('   ✓ Storage service verified.\n');
  } catch (err: any) {
    console.error('   ✗ Storage service verification FAILED:', err.message);
    process.exit(1);
  }

  // 4. Verify Queue Service Mock
  console.log('4. Verifying Queue Service (Mock/Local)...');
  try {
    const queue = getQueueService();
    const queueName = process.env.LOCAL_SQS_QUEUE_NAME || 'video-processing-queue';
    const testPayload = { testId: 'verify-123', message: 'Hello Queue Service', timestamp: Date.now() };

    // Send
    const messageId = await queue.sendMessage(queueName, testPayload);
    console.log(`   - Sent message to mock SQS. MessageId: ${messageId}`);

    // Receive
    const messages = await queue.receiveMessages(queueName, 1);
    console.log(`   - Received ${messages.length} message(s) from mock SQS`);
    
    if (messages.length === 0) {
      throw new Error('No messages received from queue');
    }

    const receivedMsg = messages[0];
    console.log(`   - Received Message ID: ${receivedMsg.MessageId}`);
    console.log(`   - Received Message Body: ${receivedMsg.Body}`);

    // Verify contents
    const parsedBody = JSON.parse(receivedMsg.Body);
    if (parsedBody.testId !== testPayload.testId) {
      throw new Error('Received message body does not match sent message');
    }

    // Delete
    await queue.deleteMessage(queueName, receivedMsg.ReceiptHandle);
    console.log(`   - Deleted message with ReceiptHandle: ${receivedMsg.ReceiptHandle}`);

    console.log('   ✓ Queue service verified.\n');
  } catch (err: any) {
    console.error('   ✗ Queue service verification FAILED:', err.message);
    process.exit(1);
  }

  console.log('==================================================');
  console.log('   ✓ Verification COMPLETED. All systems green!   ');
  console.log('==================================================');
}

runVerification().catch(err => {
  console.error('Fatal verification error:', err);
  process.exit(1);
});
