import { VideoEvent, VideoRecord } from '../../types';

export interface CreateVideoParams {
  id: string;
  originalName: string;
  fileSize: number;
  contentType: string;
  title?: string;
  qualities?: number[];
  autoPublish?: boolean;
  allowUpscale?: boolean;
  seriesId?: string;
  seasonNumber?: number;
  episodeNumber?: number;
}

export interface ListVideosResult {
  videos: VideoRecord[];
  total: number;
  page: number;
  limit: number;
}

export interface DbService {
  createVideo(params: CreateVideoParams): Promise<VideoRecord>;
  getVideo(id: string): Promise<VideoRecord | null>;
  /** Fields set to undefined are removed from the record. */
  updateVideo(id: string, updates: Partial<VideoRecord>): Promise<VideoRecord>;
  /** Appends one line to the video's processing log (kept to the most recent entries). */
  appendEvent(id: string, level: VideoEvent['level'], message: string): Promise<void>;
  /** Newest first. */
  listAll(): Promise<VideoRecord[]>;
  listVideos(page?: number, limit?: number): Promise<ListVideosResult>;
  deleteVideo(id: string): Promise<boolean>;
}

// PROVIDER picks the implementation: local = JSON file, aws = DynamoDB. Lazy requires keep the local
// files from being created in AWS mode, and the AWS SDK from loading in local mode.
function createDbService(): DbService {
  if (process.env.PROVIDER === 'aws') {
    const { DynamoDb } = require('./dynamoDb');
    return new DynamoDb();
  }
  const { JsonDb } = require('./jsonDb');
  return new JsonDb();
}

// Created on first use, not at import time: some entrypoints (worker, transcoderTask) import this
// module before dotenv has loaded PROVIDER from .env.
let instance: DbService | null = null;
const getInstance = (): DbService => (instance ??= createDbService());

export const dbService: DbService = {
  createVideo: (params) => getInstance().createVideo(params),
  getVideo: (id) => getInstance().getVideo(id),
  updateVideo: (id, updates) => getInstance().updateVideo(id, updates),
  appendEvent: (id, level, message) => getInstance().appendEvent(id, level, message),
  listAll: () => getInstance().listAll(),
  listVideos: (page, limit) => getInstance().listVideos(page, limit),
  deleteVideo: (id) => getInstance().deleteVideo(id),
};
