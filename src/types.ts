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

// An audio language found in the upload (the player's Audio menu). Order matches the master playlist.
export interface AudioTrack {
  id: string;         // "a0", "a1", ...
  language: string;   // short code, e.g. "hi"; "und" when the file does not say
  label: string;      // shown to viewers; an admin can rename it
}

// A subtitle track: pulled out of the upload ("embedded") or uploaded by an admin ("upload")
export interface TextTrack {
  id: string;
  language: string;
  label: string;
  key: string;        // file in the public bucket
  source: 'embedded' | 'upload';
}

// The section of the public site a title is filed under, besides the default Movies / Series
export type Category = 'anime';

export interface VideoRecord {
  id: string;
  originalName: string;
  title?: string;                  // display title; falls back to originalName
  status: VideoStatus;
  published?: boolean;             // visible to the public site (still requires status COMPLETED)
  publishedAt?: string;
  autoPublish?: boolean;           // publish automatically when processing completes
  qualities?: number[];            // renditions to generate; all when omitted
  allowUpscale?: boolean;          // also make sizes larger than the source (no extra detail, bigger files)
  renditions?: string[];           // what processing actually produced, e.g. ['360p', '480p']
  customThumbnailKey?: string;     // an admin-chosen thumbnail (key in the public bucket); wins over thumbnailUrl
  category?: Category;             // a standalone video shown under Anime instead of Movies
  seriesId?: string;               // set when this video is an episode of a series
  seasonNumber?: number;
  episodeNumber?: number;
  attempts?: number;               // processing attempts so far
  events?: VideoEvent[];           // processing log (capped)
  rawObjectKey?: string;
  hlsPlaylistUrl?: string;
  thumbnailUrl?: string;
  subtitleUrl?: string;
  audioTracks?: AudioTrack[];      // present when the upload had several audio languages
  textTracks?: TextTrack[];        // subtitles (embedded and uploaded)
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

// A TV series. Episodes are ordinary videos that point at it (seriesId + season + episode).
export interface Series {
  id: string;
  title: string;
  description?: string;
  category?: Category;      // shown under Anime instead of Series
  posterKey?: string;       // an admin-chosen poster (key in the public bucket); otherwise the first episode's thumbnail
  published: boolean;       // an unpublished series hides all of its episodes from the public site
  publishedAt?: string;
  seasons: number[];        // season numbers, including ones that have no episodes yet
  createdAt: string;
  updatedAt: string;
}
