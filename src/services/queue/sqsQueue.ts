import { QueueMessage, QueueService } from './queueService';
import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';

export class SqsQueue implements QueueService {
  private client: SQSClient;

  constructor() {
    this.client = new SQSClient({
      region: process.env.AWS_REGION || 'us-east-1',
    });
  }

  async sendMessage(queueUrl: string, messageBody: any): Promise<string> {
    const bodyStr = typeof messageBody === 'string' ? messageBody : JSON.stringify(messageBody);
    const command = new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: bodyStr,
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

  async deleteMessage(queueUrl: string, receiptHandle: string): Promise<void> {
    const command = new DeleteMessageCommand({
      QueueUrl: queueUrl,
      ReceiptHandle: receiptHandle,
    });
    await this.client.send(command);
  }
}
