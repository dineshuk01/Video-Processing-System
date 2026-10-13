import { DescribeTasksCommand, ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';
import { ComputeService, TranscodeJobParams } from './computeService';
import { Logger } from '../../utils/logger';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const POLL_MS = 15000;
// When AWS has no room for another task right now (the account's Fargate limit), wait for a running one to
// finish instead of failing the video: the job simply starts a little later.
const CAPACITY_WAIT_MS = 45 * 60 * 1000;
const CAPACITY_RETRY_MS = 30000;

// The transcoder exits with this code when an admin paused or deleted the video (see transcoderTask.ts)
const ABORT_EXIT_CODE = 3;

const isCapacityError = (text: string) => /limit on the number|capacity|RESOURCE:|throttl/i.test(text);

export class EcsCompute implements ComputeService {
  private client: ECSClient;
  private cluster: string;
  private taskDefinition: string;
  private containerName: string;
  private subnets: string[];
  private securityGroups: string[];

  constructor() {
    this.client = new ECSClient({ region: process.env.AWS_REGION || 'ap-south-1' });
    this.cluster = process.env.ECS_CLUSTER_NAME || 'video-processing-cluster';
    this.taskDefinition = process.env.ECS_TASK_DEFINITION || 'video-transcoder-task';
    this.containerName = process.env.ECS_CONTAINER_NAME || 'video-transcoder';
    this.subnets = (process.env.ECS_SUBNETS || '').split(',').map((s) => s.trim()).filter(Boolean);
    this.securityGroups = (process.env.ECS_SECURITY_GROUPS || '').split(',').map((s) => s.trim()).filter(Boolean);
  }

  // Starts the task, retrying while AWS reports no capacity. Returns the task's ARN.
  private async launch(params: TranscodeJobParams): Promise<string> {
    const command = new RunTaskCommand({
      cluster: this.cluster,
      taskDefinition: this.taskDefinition,
      launchType: 'FARGATE',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: this.subnets,
          securityGroups: this.securityGroups,
          assignPublicIp: 'ENABLED',
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: this.containerName,
            environment: [
              { name: 'VIDEO_ID', value: params.videoId },
              { name: 'INPUT_BUCKET', value: params.inputBucket },
              { name: 'INPUT_KEY', value: params.inputKey },
              { name: 'OUTPUT_BUCKET', value: params.outputBucket },
              { name: 'OUTPUT_KEY_PREFIX', value: params.outputKeyPrefix },
              { name: 'PROVIDER', value: 'aws' },
            ],
          },
        ],
      },
    });

    const startedWaiting = Date.now();
    for (let notified = false; ; ) {
      let failure = '';
      try {
        const response = await this.client.send(command);
        const arn = (response.tasks || [])[0]?.taskArn;
        if (arn) return arn;
        failure = (response.failures || []).map((f) => `${f.arn}: ${f.reason}`).join(', ') || 'unknown failure';
      } catch (err: any) {
        failure = err.message || String(err);
      }
      if (!isCapacityError(failure) || Date.now() - startedWaiting > CAPACITY_WAIT_MS) {
        throw new Error(`Failed to launch ECS task. Reason: ${failure}`);
      }
      if (!notified) {
        Logger.warn(`EcsCompute: no room for another task right now (${failure}). Waiting for one to finish.`);
        notified = true;
      }
      await sleep(CAPACITY_RETRY_MS);
    }
  }

  // Waits until the task has stopped and checks how it ended
  private async waitForTask(taskArn: string, videoId: string): Promise<void> {
    for (;;) {
      await sleep(POLL_MS);
      let task;
      try {
        task = (await this.client.send(new DescribeTasksCommand({ cluster: this.cluster, tasks: [taskArn] }))).tasks?.[0];
      } catch (err: any) {
        Logger.warn(`EcsCompute: could not check task ${taskArn} (will try again)`, err.message);
        continue;
      }
      if (!task) throw new Error('The encoding task disappeared before it reported a result');
      if (task.lastStatus !== 'STOPPED') continue;

      const container = (task.containers || []).find((c) => c.name === this.containerName) || task.containers?.[0];
      const exitCode = container?.exitCode;
      if (exitCode === 0) return;
      if (exitCode === ABORT_EXIT_CODE) throw new Error('The encoding task was stopped by an admin');
      const reason = container?.reason || task.stoppedReason || 'it did not report why';
      throw new Error(`The encoding task ended with ${exitCode === undefined ? 'no exit code' : `exit code ${exitCode}`} (${reason})`);
    }
  }

  async runTranscodeJob(params: TranscodeJobParams): Promise<void> {
    Logger.info(`EcsCompute: Launching ECS Fargate task for video: ${params.videoId}`);

    if (this.subnets.length === 0) {
      throw new Error('ECS Launch Configuration: subnets list (ECS_SUBNETS) is empty');
    }

    const taskArn = await this.launch(params);
    Logger.info(`EcsCompute: Launched ECS task for ${params.videoId}. Task ARN: ${taskArn}. Waiting for it to finish.`);

    // The worker slot stays busy until the task ends, so WORKER_CONCURRENCY really limits how many tasks run at once
    await this.waitForTask(taskArn, params.videoId);
    Logger.info(`EcsCompute: ECS task finished for ${params.videoId}`);
  }
}
