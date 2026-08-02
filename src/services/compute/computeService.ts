export interface TranscodeJobParams {
  videoId: string;
  inputBucket: string;
  inputKey: string;
  outputBucket: string;
  outputKeyPrefix: string;
}

export interface ComputeService {
  runTranscodeJob(params: TranscodeJobParams): Promise<void>;
}

let computeInstance: ComputeService | null = null;

export function getComputeService(): ComputeService {
  if (computeInstance) return computeInstance;

  const provider = process.env.PROVIDER || 'local';
  if (provider === 'aws') {
    // Lazy load production ECS client
    const { EcsCompute } = require('./ecsCompute');
    computeInstance = new EcsCompute();
  } else {
    // Local compute client spawning child processes
    const { LocalCompute } = require('./localCompute');
    computeInstance = new LocalCompute();
  }

  return computeInstance!;
}
