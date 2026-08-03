import client from 'prom-client';

// Initialize default Node.js process metrics (CPU, RAM, Event Loop)
client.collectDefaultMetrics({ prefix: 'video_system_' });

// Custom Prometheus Metrics
export const uploadsTotal = new client.Counter({
  name: 'video_uploads_total',
  help: 'Total number of video upload requests initiated',
  labelNames: ['status'],
});

export const transcodeJobsActive = new client.Gauge({
  name: 'video_transcode_jobs_active',
  help: 'Number of currently active transcoding jobs',
});

export const transcodeDurationSeconds = new client.Histogram({
  name: 'video_transcode_duration_seconds',
  help: 'Duration of video transcoding process in seconds',
  buckets: [5, 15, 30, 60, 120, 300, 600],
});

export const jobsFailedTotal = new client.Counter({
  name: 'video_jobs_failed_total',
  help: 'Total number of transcoding jobs that failed permanently',
});

export const getMetrics = async (): Promise<string> => {
  return client.register.metrics();
};

export const getContentType = (): string => {
  return client.register.contentType;
};
