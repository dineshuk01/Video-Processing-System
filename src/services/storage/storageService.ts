export interface StorageService {
  getSignedUrl(bucket: string, key: string, operation: 'upload' | 'download'): Promise<string>;
  uploadFile(bucket: string, key: string, filePath: string): Promise<void>;
  downloadFile(bucket: string, key: string, destPath: string): Promise<void>;
  fileExists(bucket: string, key: string): Promise<boolean>;
  deleteObject(bucket: string, key: string): Promise<void>;
  deleteDirectory(bucket: string, prefix: string): Promise<void>;
  getObjectMetadata(bucket: string, key: string): Promise<{ size: number; contentType?: string }>;
}

let storageInstance: StorageService | null = null;

export function getStorageService(): StorageService {
  if (storageInstance) return storageInstance;

  const provider = process.env.PROVIDER || 'local';
  if (provider === 'aws') {
    // Lazy load real S3 implementation to avoid requiring valid credentials/connection immediately
    const { S3Storage } = require('./s3Storage');
    storageInstance = new S3Storage();
  } else {
    const { LocalStorage } = require('./localStorage');
    storageInstance = new LocalStorage();
  }

  return storageInstance!;
}
