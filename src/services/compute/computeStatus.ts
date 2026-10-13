import { dbService } from '../db/dbService';
import { VideoStatus } from '../../types';

export interface ComputeStatus {
  provider: 'local' | 'aws';
  engine: string;
  running: number;          // videos being transcoded right now
  available: boolean;       // false when the compute backend could not be queried
  error?: string;
  tasks?: { id: string; status: string; startedAt?: string; cpu?: string; memory?: string }[];
}

// What is doing the FFmpeg work right now. Local mode runs FFmpeg in the worker's own
// subprocess, so the videos marked PROCESSING are the running jobs. In AWS mode it asks ECS.
export async function getComputeStatus(): Promise<ComputeStatus> {
  const processing = (await dbService.listAll()).filter((v) => v.status === VideoStatus.PROCESSING).length;

  if (process.env.PROVIDER !== 'aws') {
    return { provider: 'local', engine: 'Local FFmpeg process', running: processing, available: true };
  }

  const status: ComputeStatus = { provider: 'aws', engine: 'ECS Fargate + FFmpeg', running: processing, available: true };
  try {
    const { ECSClient, ListTasksCommand, DescribeTasksCommand } = require('@aws-sdk/client-ecs');
    const client = new ECSClient({ region: process.env.AWS_REGION || 'us-east-1' });
    const cluster = process.env.ECS_CLUSTER_NAME || 'video-processing-cluster';
    const listed = await client.send(new ListTasksCommand({ cluster, desiredStatus: 'RUNNING', maxResults: 25 }));
    const arns: string[] = listed.taskArns || [];
    if (arns.length > 0) {
      const described = await client.send(new DescribeTasksCommand({ cluster, tasks: arns }));
      status.tasks = (described.tasks || []).map((t: any) => ({
        id: String(t.taskArn).split('/').pop() || '',
        status: t.lastStatus,
        startedAt: t.startedAt ? new Date(t.startedAt).toISOString() : undefined,
        cpu: t.cpu,
        memory: t.memory,
      }));
    } else {
      status.tasks = [];
    }
  } catch (err: any) {
    status.available = false;
    status.error = err.message;
  }
  return status;
}
