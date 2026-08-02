export interface QueueMessage {
  MessageId: string;
  ReceiptHandle: string;
  Body: string;
}

export interface QueueService {
  sendMessage(queueUrl: string, messageBody: any): Promise<string>;
  receiveMessages(queueUrl: string, maxMessages: number): Promise<QueueMessage[]>;
  deleteMessage(queueUrl: string, receiptHandle: string): Promise<void>;
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
