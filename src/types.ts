export enum VideoStatus {
  PENDING = 'PENDING',
  UPLOADING = 'UPLOADING',
  UPLOADED = 'UPLOADED',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED'
}

export interface VideoRecord {
  id: string;
  originalName: string;
  status: VideoStatus;
  rawObjectKey?: string;
  hlsPlaylistUrl?: string;
  thumbnailUrl?: string;
  error?: string;
  progress: number; // 0 to 100
  fileSize: number; // in bytes
  contentType: string; // e.g. 'video/mp4'
  createdAt: string;
  updatedAt: string;
  processingStartedAt?: string;
  completedAt?: string;
  failedAt?: string;
}
