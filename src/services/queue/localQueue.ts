import * as fs from 'fs';
import * as path from 'path';
import { QueueMessage, QueueService } from './queueService';

interface FileQueueMessage {
  id: string;
  body: string;
  visibleAfter: number; // For visibility timeout simulation
}

export class LocalQueue implements QueueService {
  private queueFilePath: string;
  private visibilityTimeoutMs = 30000; // 30 seconds

  constructor() {
    const dataDir = path.resolve(process.env.LOCAL_DATA_DIR || './data');
    const queueDir = path.join(dataDir, 'queue');
    if (!fs.existsSync(queueDir)) {
      fs.mkdirSync(queueDir, { recursive: true });
    }
    this.queueFilePath = path.join(queueDir, 'messages.json');
    if (!fs.existsSync(this.queueFilePath)) {
      fs.writeFileSync(this.queueFilePath, JSON.stringify([]));
    }
  }

  private readQueue(): FileQueueMessage[] {
    try {
      const data = fs.readFileSync(this.queueFilePath, 'utf8');
      return JSON.parse(data);
    } catch (err) {
      return [];
    }
  }

  private writeQueue(messages: FileQueueMessage[]) {
    fs.writeFileSync(this.queueFilePath, JSON.stringify(messages, null, 2));
  }

  async sendMessage(queueUrl: string, messageBody: any): Promise<string> {
    const messages = this.readQueue();
    const messageId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    const bodyStr = typeof messageBody === 'string' ? messageBody : JSON.stringify(messageBody);

    messages.push({
      id: messageId,
      body: bodyStr,
      visibleAfter: 0
    });

    this.writeQueue(messages);
    return messageId;
  }

  async receiveMessages(queueUrl: string, maxMessages: number): Promise<QueueMessage[]> {
    const messages = this.readQueue();
    const now = Date.now();
    const received: QueueMessage[] = [];

    for (const msg of messages) {
      if (received.length >= maxMessages) break;
      if (msg.visibleAfter <= now) {
        msg.visibleAfter = now + this.visibilityTimeoutMs;
        received.push({
          MessageId: msg.id,
          ReceiptHandle: msg.id,
          Body: msg.body
        });
      }
    }

    if (received.length > 0) {
      this.writeQueue(messages);
    }

    return received;
  }

  async deleteMessage(queueUrl: string, receiptHandle: string): Promise<void> {
    let messages = this.readQueue();
    const originalLength = messages.length;
    messages = messages.filter((msg) => msg.id !== receiptHandle);

    if (messages.length !== originalLength) {
      this.writeQueue(messages);
    }
  }
}
