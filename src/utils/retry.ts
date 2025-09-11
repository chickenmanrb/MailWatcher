import { logger } from './logger.js';

export interface RetryOptions {
  maxAttempts?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffFactor?: number;
  jitter?: boolean;
  shouldRetry?: (error: any, attempt: number) => boolean;
  onRetry?: (error: any, attempt: number, delay: number) => void;
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  initialDelay: 1000,
  maxDelay: 30000,
  backoffFactor: 2,
  jitter: true,
  shouldRetry: () => true,
  onRetry: () => {},
};

export async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: any;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      logger.debug('Retry', `Attempting ${operationName}`, { attempt, maxAttempts: opts.maxAttempts });
      const result = await operation();
      if (attempt > 1) {
        logger.info('Retry', `${operationName} succeeded after ${attempt} attempts`);
      }
      return result;
    } catch (error) {
      lastError = error;
      
      if (attempt === opts.maxAttempts || !opts.shouldRetry(error, attempt)) {
        logger.error('Retry', `${operationName} failed after ${attempt} attempts`, { error: String(error) });
        throw error;
      }

      const baseDelay = Math.min(
        opts.initialDelay * Math.pow(opts.backoffFactor, attempt - 1),
        opts.maxDelay
      );
      
      const delay = opts.jitter
        ? baseDelay * (0.5 + Math.random())
        : baseDelay;

      logger.warn('Retry', `${operationName} failed, retrying in ${Math.round(delay)}ms`, {
        attempt,
        error: String(error),
      });

      opts.onRetry(error, attempt, delay);
      await sleep(delay);
    }
  }

  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class RetryableOperation {
  private options: Required<RetryOptions>;

  constructor(options: RetryOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async execute<T>(operation: () => Promise<T>, name: string): Promise<T> {
    return withRetry(operation, name, this.options);
  }

  withOptions(options: RetryOptions): RetryableOperation {
    return new RetryableOperation({ ...this.options, ...options });
  }
}

export const defaultRetry = new RetryableOperation();

export const formRetry = new RetryableOperation({
  maxAttempts: 3,
  initialDelay: 500,
  shouldRetry: (error) => {
    const message = String(error).toLowerCase();
    return !message.includes('timeout') || !message.includes('navigation');
  },
});

export const downloadRetry = new RetryableOperation({
  maxAttempts: 5,
  initialDelay: 2000,
  maxDelay: 60000,
  shouldRetry: (error, attempt) => {
    const message = String(error).toLowerCase();
    if (message.includes('not found') || message.includes('404')) {
      return false;
    }
    return attempt < 5;
  },
});