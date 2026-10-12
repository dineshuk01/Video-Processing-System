export interface QueueMessage {
  MessageId: string;
  ReceiptHandle: string;
  Body: string;
}

export interface QueueStats {
  waiting: number;    // messages ready to be picked up
  inFlight: number;   // messages currently being processed (hidden by the visibility timeout)
  delayed: number;    // messages scheduled for later
  /** A short preview of queued jobs (local queue only) */
  jobs?: { videoId: string; retryCount: number; state: 'waiting' | 'in-flight' | 'delayed' }[];
}

export interface QueueService {
  /** `delaySeconds` hides the message from workers for that long (used for retry backoff). */
  sendMessage(queueUrl: string, messageBody: any, delaySeconds?: number): Promise<string>;
  receiveMessages(queueUrl: string, maxMessages: number): Promise<QueueMessage[]>;
  deleteMessage(queueUrl: string, receiptHandle: string): Promise<void>;
  getStats(queueUrl: string): Promise<QueueStats>;
}

let queueInstance: QueueService | null = null;

export function getQueueService(): QueueService {
  if (queueInstance) return queueInstance;

  const provider = process.env.PROVIDER || 'local';
  if (provider === 'aws') {
    // Lazy load real SQS implementation
    const { SqsQueue } = require('./sqsQueue');
    queueInstance = new SqsQueue();
  } else {
    const { LocalQueue } = require('./localQueue');
    queueInstance = new LocalQueue();
  }

  return queueInstance!;
}
