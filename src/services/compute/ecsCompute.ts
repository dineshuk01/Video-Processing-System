import { ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';
import { ComputeService, TranscodeJobParams } from './computeService';
import { Logger } from '../../utils/logger';

export class EcsCompute implements ComputeService {
  private client: ECSClient;
  private cluster: string;
  private taskDefinition: string;
  private containerName: string;
  private subnets: string[];
  private securityGroups: string[];

  constructor() {
    this.client = new ECSClient({ region: process.env.AWS_REGION || 'us-east-1' });
    this.cluster = process.env.ECS_CLUSTER_NAME || 'video-processing-cluster';
    this.taskDefinition = process.env.ECS_TASK_DEFINITION || 'video-transcoder-task';
    this.containerName = process.env.ECS_CONTAINER_NAME || 'video-transcoder';
    this.subnets = (process.env.ECS_SUBNETS || '').split(',').map((s) => s.trim()).filter(Boolean);
    this.securityGroups = (process.env.ECS_SECURITY_GROUPS || '').split(',').map((s) => s.trim()).filter(Boolean);
  }

  async runTranscodeJob(params: TranscodeJobParams): Promise<void> {
    Logger.info(`EcsCompute: Launching ECS Fargate task for video: ${params.videoId}`);

    if (this.subnets.length === 0) {
      throw new Error('ECS Launch Configuration: subnets list (ECS_SUBNETS) is empty');
    }

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

    const response = await this.client.send(command);
    const tasks = response.tasks || [];
    if (tasks.length === 0) {
      const failures = response.failures || [];
      const failureReason = failures.map((f) => `${f.arn}: ${f.reason}`).join(', ');
      throw new Error(`Failed to launch ECS task. Reason: ${failureReason || 'unknown failure'}`);
    }

    const taskArn = tasks[0].taskArn;
    Logger.info(`EcsCompute: Successfully launched ECS task. Task ARN: ${taskArn}`);
  }
}
