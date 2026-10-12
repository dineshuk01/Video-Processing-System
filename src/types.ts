export enum VideoStatus {
  PENDING = 'PENDING',
  UPLOADING = 'UPLOADING',
  UPLOADED = 'UPLOADED',
  PROCESSING = 'PROCESSING',
  PAUSED = 'PAUSED',            // stopped by an admin; the original is kept and can be processed again
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED'
}

export interface VideoMetadata {
  width: number;
  height: number;
  duration: number;   // seconds
  codec: string;
  fps: number;
  bitrate?: number;   // kbps
}

// One line in a video's processing log, shown to admins only
export interface VideoEvent {
  at: string;         // ISO timestamp
  level: 'info' | 'warn' | 'error';
  message: string;
}

// Renditions an admin can choose to generate (heights in pixels)
export const AVAILABLE_QUALITIES = [360, 480, 720, 1080] as const;

export interface VideoRecord {
  id: string;
  originalName: string;
  title?: string;                  // display title; falls back to originalName
  status: VideoStatus;
  published?: boolean;             // visible to the public site (still requires status COMPLETED)
  publishedAt?: string;
  autoPublish?: boolean;           // publish automatically when processing completes
  qualities?: number[];            // renditions to generate; all when omitted
  attempts?: number;               // processing attempts so far
  events?: VideoEvent[];           // processing log (capped)
  rawObjectKey?: string;
  hlsPlaylistUrl?: string;
  thumbnailUrl?: string;
  subtitleUrl?: string;
  error?: string;
  progress: number; // 0 to 100
  fileSize: number; // in bytes
  contentType: string; // e.g. 'video/mp4'
  metadata?: VideoMetadata;
  createdAt: string;
  updatedAt: string;
  processingStartedAt?: string;
  completedAt?: string;
  failedAt?: string;
}
