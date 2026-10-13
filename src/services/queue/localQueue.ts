import * as fs from 'fs';
import * as path from 'path';
import { QueueMessage, QueueService, QueueStats } from './queueService';
import { withFileLock, writeFileAtomic } from '../../utils/fileLock';

interface FileQueueMessage {
  id: string;
  body: string;
  visibleAfter: number; // For visibility timeout simulation
  received?: boolean;   // true once a worker has picked the message up (tells in-flight from delayed)
}

export class LocalQueue implements QueueService {
  private queueFilePath: string;
  private lockPath: string;
  private visibilityTimeoutMs = 30000; // 30 seconds

  constructor() {
    const dataDir = path.resolve(process.env.LOCAL_DATA_DIR || './data');
    const queueDir = path.join(dataDir, 'queue');
    if (!fs.existsSync(queueDir)) {
      fs.mkdirSync(queueDir, { recursive: true });
    }
    this.queueFilePath = path.join(queueDir, 'messages.json');
    this.lockPath = `${this.queueFilePath}.lock`;
    if (!fs.existsSync(this.queueFilePath)) {
      fs.writeFileSync(this.queueFilePath, JSON.stringify([]));
    }
  }

  private readQueue(): FileQueueMessage[] {
    try {
      return JSON.parse(fs.readFileSync(this.queueFilePath, 'utf8'));
    } catch {
      return [];
    }
  }

  // The API and the worker are separate processes sharing this file, so every change is
  // a locked read-modify-write; otherwise one process can overwrite the other's message.
  private mutate<T>(fn: (messages: FileQueueMessage[]) => { result: T; write: boolean }): Promise<T> {
    return withFileLock(this.lockPath, async () => {
      const messages = this.readQueue();
      const { result, write } = fn(messages);
      if (write) await writeFileAtomic(this.queueFilePath, JSON.stringify(messages, null, 2));
      return result;
    });
  }

  async sendMessage(queueUrl: string, messageBody: any, delaySeconds = 0): Promise<string> {
    const messageId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    const bodyStr = typeof messageBody === 'string' ? messageBody : JSON.stringify(messageBody);
    return this.mutate((messages) => {
      messages.push({ id: messageId, body: bodyStr, visibleAfter: delaySeconds > 0 ? Date.now() + delaySeconds * 1000 : 0 });
      return { result: messageId, write: true };
    });
  }

  async receiveMessages(queueUrl: string, maxMessages: number): Promise<QueueMessage[]> {
    return this.mutate((messages) => {
      const now = Date.now();
      const received: QueueMessage[] = [];
      for (const msg of messages) {
        if (received.length >= maxMessages) break;
        if (msg.visibleAfter <= now) {
          msg.visibleAfter = now + this.visibilityTimeoutMs;
          msg.received = true;
          received.push({ MessageId: msg.id, ReceiptHandle: msg.id, Body: msg.body });
        }
      }
      return { result: received, write: received.length > 0 };
    });
  }

  async deleteMessage(queueUrl: string, receiptHandle: string): Promise<void> {
    await this.mutate((messages) => {
      const index = messages.findIndex((msg) => msg.id === receiptHandle);
      if (index >= 0) messages.splice(index, 1);
      return { result: undefined, write: index >= 0 };
    });
  }

  async getStats(queueUrl: string): Promise<QueueStats> {
    const now = Date.now();
    const jobs = this.readQueue().map((msg) => {
      let payload: any = {};
      try { payload = JSON.parse(msg.body); } catch { /* malformed body: shown as unknown */ }
      return {
        videoId: String(payload.videoId || 'unknown'),
        retryCount: Number(payload.retryCount || 0),
        state: (msg.visibleAfter > now ? (msg.received ? 'in-flight' : 'delayed') : 'waiting') as 'in-flight' | 'waiting' | 'delayed',
      };
    });
    return {
      waiting: jobs.filter((j) => j.state === 'waiting').length,
      inFlight: jobs.filter((j) => j.state === 'in-flight').length,
      delayed: jobs.filter((j) => j.state === 'delayed').length,
      jobs: jobs.slice(0, 25),
    };
  }
}
