export class Logger {
  private static formatMessage(level: string, message: string, context?: any): string {
    const timestamp = new Date().toISOString();
    const contextStr = context 
      ? ` | Details: ${typeof context === 'object' ? JSON.stringify(context) : context}`
      : '';
    return `[${timestamp}] [${level.toUpperCase()}] ${message}${contextStr}`;
  }

  static info(message: string, context?: any) {
    console.log(this.formatMessage('info', message, context));
  }

  static warn(message: string, context?: any) {
    console.warn(this.formatMessage('warn', message, context));
  }

  static error(message: string, context?: any) {
    console.error(this.formatMessage('error', message, context));
  }

  static debug(message: string, context?: any) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(this.formatMessage('debug', message, context));
    }
  }
}
