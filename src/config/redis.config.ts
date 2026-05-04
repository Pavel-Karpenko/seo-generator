import { registerAs } from '@nestjs/config';
import type { RedisOptions } from 'ioredis';

export interface RedisConfig {
  url: string;
  options: RedisOptions;
}

const MAX_RETRY_ATTEMPTS = 10;
const INITIAL_RETRY_DELAY_MS = 50;
const MAX_RETRY_DELAY_MS = 2000;

export default registerAs('redis', (): RedisConfig => {
  const url = process.env['REDIS_URL'];

  if (!url) {
    throw new Error('REDIS_URL environment variable is required.');
  }

  try {
    new URL(url);
  } catch {
    throw new Error(`REDIS_URL is not a valid URL: "${url}".`);
  }

  const options: RedisOptions = {
    // Exponential backoff with jitter for reconnection
    retryStrategy: (times: number): number | null => {
      if (times > MAX_RETRY_ATTEMPTS) {
        return null; // Stop retrying — let the error propagate
      }
      const delay = Math.min(
        INITIAL_RETRY_DELAY_MS * 2 ** times + Math.random() * 100,
        MAX_RETRY_DELAY_MS,
      );
      return delay;
    },
    // Reconnect on these errors
    reconnectOnError: (err: Error): boolean => {
      const reconnectableErrors = ['READONLY', 'ECONNRESET', 'ECONNREFUSED'];
      return reconnectableErrors.some((msg) => err.message.includes(msg));
    },
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  };

  return { url, options };
});
