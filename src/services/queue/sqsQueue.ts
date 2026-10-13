import { QueueMessage, QueueService, QueueStats } from './queueService';
import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';

export class SqsQueue implements QueueService {
  private client: SQSClient;

  constructor() {
    this.client = new SQSClient({
      region: process.env.AWS_REGION || 'us-east-1',
    });
  }

  async sendMessage(queueUrl: string, messageBody: any, delaySeconds = 0): Promise<string> {
    const bodyStr = typeof messageBody === 'string' ? messageBody : JSON.stringify(messageBody);
    const command = new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: bodyStr,
      DelaySeconds: Math.min(900, Math.max(0, Math.round(delaySeconds))), // SQS allows at most 15 minutes
    });
    const response = await this.client.send(command);
    return response.MessageId || '';
  }

  async receiveMessages(queueUrl: string, maxMessages: number): Promise<QueueMessage[]> {
    const command = new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: maxMessages,
      WaitTimeSeconds: 5,
    });
    const response = await this.client.send(command);
    const messages = response.Messages || [];

    return messages.map((msg) => ({
      MessageId: msg.MessageId || '',
      ReceiptHandle: msg.ReceiptHandle || '',
      Body: msg.Body || '',
    }));
  }

  async getStats(queueUrl: string): Promise<QueueStats> {
    const response = await this.client.send(new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: [
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
        'ApproximateNumberOfMessagesDelayed',
      ],
    }));
    const attrs = response.Attributes || {};
    return {
      waiting: parseInt(attrs.ApproximateNumberOfMessages || '0', 10),
      inFlight: parseInt(attrs.ApproximateNumberOfMessagesNotVisible || '0', 10),
      delayed: parseInt(attrs.ApproximateNumberOfMessagesDelayed || '0', 10),
    };
  }

  async deleteMessage(queueUrl: string, receiptHandle: string): Promise<void> {
    const command = new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: receiptHandle,
    });
    await this.client.send(command);
  }
}
