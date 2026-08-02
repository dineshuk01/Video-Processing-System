import { spawn } from 'child_process';
import * as path from 'path';
import { ComputeService, TranscodeJobParams } from './computeService';
import { Logger } from '../../utils/logger';

export class LocalCompute implements ComputeService {
  async runTranscodeJob(params: TranscodeJobParams): Promise<void> {
    Logger.info(`LocalCompute: Spawning local transcoder subprocess for video: ${params.videoId}`);

    const taskScriptPath = path.resolve(__dirname, '../../transcoderTask.ts');

    // Spawn ts-node to execute the task script. Use shell: true for Windows cross-compatibility.
    const child = spawn('npx', ['ts-node', taskScriptPath], {
      shell: true,
      env: {
        ...process.env,
        VIDEO_ID: params.videoId,
        INPUT_BUCKET: params.inputBucket,
        INPUT_KEY: params.inputKey,
        OUTPUT_BUCKET: params.outputBucket,
        OUTPUT_KEY_PREFIX: params.outputKeyPrefix,
      },
    });

    child.stdout.on('data', (data) => {
      const line = data.toString().trim();
      if (line) {
        Logger.info(`[Transcoder Subprocess] ${line}`);
      }
    });

    child.stderr.on('data', (data) => {
      const line = data.toString().trim();
      if (line) {
        Logger.error(`[Transcoder Subprocess Error] ${line}`);
      }
    });

    return new Promise<void>((resolve, reject) => {
      child.on('close', (code) => {
        if (code === 0) {
          Logger.info(`LocalCompute: Local transcoder subprocess finished successfully for video: ${params.videoId}`);
          resolve();
        } else {
          Logger.error(`LocalCompute: Local transcoder subprocess failed with exit code: ${code}`);
          reject(new Error(`Transcoder subprocess exited with code ${code}`));
        }
      });
    });
  }
}
