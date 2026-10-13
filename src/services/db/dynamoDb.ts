import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { VideoEvent, VideoRecord, VideoStatus } from '../../types';
import { Logger } from '../../utils/logger';
import type { CreateVideoParams, DbService, ListVideosResult } from './dbService';

// One table holds everything (see terraform/main.tf):
//   PK  id (S)         a video's id, or "series#<id>" for a series
//   GSI "createdAt-index": partition key `entity` ("VIDEO" or "SERIES"), sort key `createdAt`
// The constant `entity` attribute lets the index list every video (or series) newest-first with a
// Query instead of scanning the table.
export const VIDEO_ENTITY = 'VIDEO';
export const SERIES_ENTITY = 'SERIES';
export const LIST_INDEX = 'createdAt-index';

const MAX_EVENTS_PER_VIDEO = 200;

export function createDocClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(
    // DYNAMODB_ENDPOINT points the app at a local DynamoDB emulator (used by tests)
    new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-south-1', ...(process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {}) }),
    // Optional fields such as thumbnailUrl are often passed as undefined
    { marshallOptions: { removeUndefinedValues: true } }
  );
}

export function tableName(): string {
  const table = process.env.DYNAMODB_TABLE_NAME;
  if (!table) throw new Error('DYNAMODB_TABLE_NAME is required when PROVIDER=aws');
  return table;
}

// Every item of one kind, newest first (follows the pages DynamoDB returns)
export async function queryAllByEntity(doc: DynamoDBDocumentClient, table: string, entity: string): Promise<Record<string, any>[]> {
  const items: Record<string, any>[] = [];
  let startKey: Record<string, any> | undefined;
  do {
    const result = await doc.send(
      new QueryCommand({
        TableName: table,
        IndexName: LIST_INDEX,
        KeyConditionExpression: 'entity = :e',
        ExpressionAttributeValues: { ':e': entity },
        ScanIndexForward: false, // newest first
        ExclusiveStartKey: startKey,
      })
    );
    items.push(...(result.Items || []));
    startKey = result.LastEvaluatedKey;
  } while (startKey);
  return items;
}

export class DynamoDb implements DbService {
  private doc = createDocClient();
  private table = tableName();

  // Drop the internal `entity` attribute before records leave this class
  private toRecord(item: Record<string, any>): VideoRecord {
    const { entity, ...record } = item;
    return record as VideoRecord;
  }

  async createVideo(params: CreateVideoParams): Promise<VideoRecord> {
    const now = new Date().toISOString();
    const item = {
      id: params.id,
      entity: VIDEO_ENTITY,
      originalName: params.originalName,
      title: params.title,
      status: VideoStatus.PENDING,
      published: false,
      autoPublish: !!params.autoPublish,
      qualities: params.qualities,
      allowUpscale: !!params.allowUpscale,
      seriesId: params.seriesId,
      seasonNumber: params.seasonNumber,
      episodeNumber: params.episodeNumber,
      attempts: 0,
      events: [{ at: now, level: 'info', message: 'Upload started' }],
      progress: 0,
      fileSize: params.fileSize,
      contentType: params.contentType,
      createdAt: now,
      updatedAt: now,
    };

    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: item,
        ConditionExpression: 'attribute_not_exists(id)', // never overwrite an existing video
      })
    );
    Logger.info(`Created database record for video: ${params.id}`);
    return this.toRecord(item);
  }

  async getVideo(id: string): Promise<VideoRecord | null> {
    // Strongly consistent, so the API sees what the transcoder task just wrote
    const result = await this.doc.send(new GetCommand({ TableName: this.table, Key: { id }, ConsistentRead: true }));
    return result.Item && result.Item.entity === VIDEO_ENTITY ? this.toRecord(result.Item) : null;
  }

  async updateVideo(id: string, updates: Partial<VideoRecord>): Promise<VideoRecord> {
    const now = new Date().toISOString();
    const fields: Record<string, any> = { ...updates, updatedAt: now };

    // Same timestamp transitions as the JSON implementation
    if (updates.status === VideoStatus.PROCESSING) fields.processingStartedAt = now;
    else if (updates.status === VideoStatus.COMPLETED) fields.completedAt = now;
    else if (updates.status === VideoStatus.FAILED) fields.failedAt = now;
    if (updates.published === true) {
      const current = await this.getVideo(id);
      if (current && !current.published) fields.publishedAt = now;
    }

    // The key and entity can never be changed through an update
    delete fields.id;
    delete fields.entity;

    // Attribute names are aliased because words like `status` and `error` are DynamoDB reserved words.
    // A field set to undefined is removed (that is how "clear the custom thumbnail" works).
    const names: Record<string, string> = {};
    const values: Record<string, any> = {};
    const sets: string[] = [];
    const removes: string[] = [];
    Object.entries(fields).forEach(([key, value], i) => {
      names[`#k${i}`] = key;
      if (value === undefined) {
        removes.push(`#k${i}`);
      } else {
        values[`:v${i}`] = value;
        sets.push(`#k${i} = :v${i}`);
      }
    });
    const expression = [sets.length ? `SET ${sets.join(', ')}` : '', removes.length ? `REMOVE ${removes.join(', ')}` : ''].filter(Boolean).join(' ');

    try {
      const result = await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { id },
          UpdateExpression: expression,
          ConditionExpression: 'attribute_exists(id)', // an update must not create a new item
          ExpressionAttributeNames: names,
          ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
          ReturnValues: 'ALL_NEW',
        })
      );
      Logger.info(`Updated database record for video: ${id}`, { status: updates.status });
      return this.toRecord(result.Attributes!);
    } catch (err: any) {
      if (err.name === 'ConditionalCheckFailedException') throw new Error(`Video with ID ${id} not found in database`);
      throw err;
    }
  }

  async appendEvent(id: string, level: VideoEvent['level'], message: string): Promise<void> {
    const now = new Date().toISOString();
    try {
      const result = await this.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { id },
          UpdateExpression: 'SET #ev = list_append(if_not_exists(#ev, :none), :one), updatedAt = :now',
          ConditionExpression: 'attribute_exists(id)',
          ExpressionAttributeNames: { '#ev': 'events' },
          ExpressionAttributeValues: { ':none': [], ':one': [{ at: now, level, message }], ':now': now },
          ReturnValues: 'UPDATED_NEW',
        })
      );
      const events: VideoEvent[] = (result.Attributes && result.Attributes.events) || [];
      if (events.length > MAX_EVENTS_PER_VIDEO) {
        // Keep only the most recent lines; losing a race with another append here costs at most one line
        await this.doc.send(
          new UpdateCommand({
            TableName: this.table,
            Key: { id },
            UpdateExpression: 'SET #ev = :kept',
            ConditionExpression: 'attribute_exists(id)',
            ExpressionAttributeNames: { '#ev': 'events' },
            ExpressionAttributeValues: { ':kept': events.slice(-MAX_EVENTS_PER_VIDEO) },
          })
        ).catch(() => { /* the video was deleted meanwhile */ });
      }
    } catch (err: any) {
      if (err.name === 'ConditionalCheckFailedException') return; // video deleted meanwhile; nothing to log to
      throw err;
    }
  }

  async listAll(): Promise<VideoRecord[]> {
    return (await queryAllByEntity(this.doc, this.table, VIDEO_ENTITY)).map((i) => this.toRecord(i));
  }

  async listVideos(page: number = 1, limit: number = 10): Promise<ListVideosResult> {
    const all = await this.listAll();
    const start = (page - 1) * limit;
    return { videos: all.slice(start, start + limit), total: all.length, page, limit };
  }

  async deleteVideo(id: string): Promise<boolean> {
    const result = await this.doc.send(
      new DeleteCommand({
        TableName: this.table,
        Key: { id },
        ConditionExpression: 'entity = :v',
        ExpressionAttributeValues: { ':v': VIDEO_ENTITY },
        ReturnValues: 'ALL_OLD',
      })
    ).catch((err: any) => {
      if (err.name === 'ConditionalCheckFailedException') return { Attributes: undefined };
      throw err;
    });
    const existed = !!result.Attributes;
    if (existed) Logger.info(`Deleted database record for video: ${id}`);
    return existed;
  }
}
