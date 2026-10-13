import { StorageService } from './storageService';
import { 
  S3Client, 
  GetObjectCommand, 
  PutObjectCommand, 
  HeadObjectCommand, 
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { Logger } from '../../utils/logger';

export class S3Storage implements StorageService {
  private client: S3Client;

  constructor() {
    this.client = new S3Client({
      region: process.env.AWS_REGION || 'us-east-1',
    });
  }

  async getSignedUrl(bucket: string, key: string, operation: 'upload' | 'download'): Promise<string> {
    const command = operation === 'upload'
      ? new PutObjectCommand({ Bucket: bucket, Key: key })
      : new GetObjectCommand({ Bucket: bucket, Key: key });

    // Presigned URL expires in 1 hour (3600 seconds)
    return getSignedUrl(this.client, command, { expiresIn: 3600 });
  }

  async uploadFile(bucket: string, key: string, filePath: string): Promise<void> {
    const fileStream = fs.createReadStream(filePath);
    await this.client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fileStream,
    }));
  }

  async downloadFile(bucket: string, key: string, destPath: string): Promise<void> {
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    const response = await this.client.send(command);
    const body = response.Body;

    if (body instanceof Readable) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const writeStream = fs.createWriteStream(destPath);
      await new Promise<void>((resolve, reject) => {
        body.pipe(writeStream)
          .on('finish', () => resolve())
          .on('error', (err) => reject(err));
      });
    } else {
      throw new Error('S3 response body is not a readable stream');
    }
  }

  async fileExists(bucket: string, key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch (err: any) {
      // Handle various forms of "object not found" error across SDK versions
      const errName = err.name || '';
      const statusCode = err.$metadata?.httpStatusCode;
      if (
        errName === 'NoSuchKey' || 
        errName === 'NotFound' || 
        statusCode === 404
      ) {
        return false;
      }
      throw err;
    }
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  // Deletes every object under `prefix/` (a "directory"), in pages of up to 1000 keys
  async deleteDirectory(bucket: string, prefix: string): Promise<void> {
    const dirPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
    let continuationToken: string | undefined;
    let deleted = 0;

    do {
      const listed = await this.client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: dirPrefix,
        ContinuationToken: continuationToken,
      }));
      const keys = (listed.Contents || []).map((o) => ({ Key: o.Key! }));
      if (keys.length > 0) {
        const result = await this.client.send(new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys, Quiet: true },
        }));
        if (result.Errors && result.Errors.length > 0) {
          throw new Error(`Failed to delete ${result.Errors.length} object(s) under ${dirPrefix}: ${result.Errors[0].Message}`);
        }
        deleted += keys.length;
      }
      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);

    Logger.info(`S3: deleted ${deleted} object(s) under ${bucket}/${dirPrefix}`);
  }

  async getObjectMetadata(bucket: string, key: string): Promise<{ size: number; contentType?: string }> {
    try {
      const response = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return {
        size: response.ContentLength || 0,
        contentType: response.ContentType,
      };
    } catch (err: any) {
      throw new Error(`Failed to get S3 metadata for ${bucket}/${key}: ${err.message}`);
    }
  }
}
