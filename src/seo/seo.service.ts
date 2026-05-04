import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { Observable } from 'rxjs';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import type { GenerateSeoDto } from './dto/generate-seo.dto';
import type { SeoResult } from './schemas/seo-result.schema';

/** If no message arrives within this many ms, the SSE stream times out */
const SSE_IDLE_TIMEOUT_MS = 100_000;

/** BullMQ queue name constant — must match processor decorator */
export const SEO_QUEUE_NAME = 'seo';

export interface SeoJobData {
  jobId: string;
  product_name: string;
  category: string;
  keywords: string[];
  session_id: string;
  correlationId: string;
}

/** Discriminated union for all Redis pub/sub message types */
export type SeoStreamMessage =
  | { type: 'token'; data: string }
  | { type: 'complete'; data: SeoResult }
  | { type: 'error'; code: string; message: string }
  | { type: 'done' };

interface MessageEvent {
  data: string | object;
  id?: string;
  type?: string;
  retry?: number;
}

@Injectable()
export class SeoService implements OnModuleDestroy {
  private readonly logger = new Logger(SeoService.name);
  private readonly redisUrl: string;

  constructor(
    @InjectQueue(SEO_QUEUE_NAME) private readonly seoQueue: Queue<SeoJobData>,
    private readonly configService: ConfigService,
  ) {
    this.redisUrl = this.configService.getOrThrow<string>('redis.url');
  }

  onModuleDestroy(): void {
    this.logger.log('SeoService shutting down');
  }

  /**
   * Enqueues a SEO generation job.
   * Uses the jobId as the BullMQ job ID to prevent duplicate jobs.
   */
  async enqueue(
    dto: GenerateSeoDto,
    correlationId: string,
  ): Promise<{ jobId: string; streamUrl: string }> {
    const jobId = uuidv4();
    const sessionId = dto.session_id ?? uuidv4();

    const jobData: SeoJobData = {
      jobId,
      product_name: dto.product_name,
      category: dto.category,
      keywords: dto.keywords,
      session_id: sessionId,
      correlationId,
    };

    await this.seoQueue.add(SEO_QUEUE_NAME, jobData, {
      jobId,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1_000,
      },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
    });

    const streamUrl = `/api/seo/${jobId}/stream`;

    return { jobId, streamUrl };
  }

  /**
   * Creates an SSE Observable for the given jobId.
   *
   * CRITICAL: uses a DEDICATED ioredis subscriber connection per client.
   * Never reuse the main command connection for pub/sub.
   * Teardown (client disconnect) unsubscribes and quits the connection.
   */
  createSseStream(jobId: string, correlationId: string): Observable<MessageEvent> {
    const channel = `seo:stream:${jobId}`;

    return new Observable<MessageEvent>((subscriber) => {
      const redisOptions = this.configService.get('redis.options') ?? {};
      const redis = new Redis(this.redisUrl, {
        ...redisOptions,
        // Use a dedicated connection for pub/sub — never share
        lazyConnect: false,
      });

      let idleTimer: NodeJS.Timeout | null = null;

      const resetIdleTimer = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          this.logger.warn(
            { correlationId, jobId },
            `SSE stream idle timeout after ${SSE_IDLE_TIMEOUT_MS}ms`,
          );
          subscriber.next({
            type: 'error',
            data: JSON.stringify({
              type: 'error',
              code: 'STREAM_TIMEOUT',
              message: `No data received within ${SSE_IDLE_TIMEOUT_MS}ms`,
            }),
          });
          subscriber.complete();
        }, SSE_IDLE_TIMEOUT_MS);
      };

      const cleanup = async (): Promise<void> => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        try {
          await redis.unsubscribe(channel);
          redis.disconnect();
        } catch (err: unknown) {
          this.logger.warn(
            { correlationId, jobId, error: String(err) },
            'Error during SSE Redis subscriber cleanup',
          );
        }
      };

      redis.on('error', (err: Error) => {
        this.logger.error(
          { correlationId, jobId, error: err.message },
          'Redis subscriber connection error',
        );
        subscriber.next({
          type: 'error',
          data: JSON.stringify({
            type: 'error',
            code: 'REDIS_ERROR',
            message: 'Redis connection error',
          }),
        });
        subscriber.complete();
      });

      redis.on('ready', () => {
        this.logger.debug(
          { correlationId, jobId, channel },
          'Redis subscriber ready, subscribing to channel',
        );

        redis.subscribe(channel, (err: Error | null) => {
          if (err) {
            this.logger.error(
              { correlationId, jobId, channel, error: err.message },
              'Failed to subscribe to Redis channel',
            );
            subscriber.error(err);
            return;
          }
          resetIdleTimer();
        });
      });

      redis.on(
        'message',
        (receivedChannel: string, rawMessage: string) => {
          if (receivedChannel !== channel) return;

          resetIdleTimer();

          let message: SeoStreamMessage;
          try {
            message = JSON.parse(rawMessage) as SeoStreamMessage;
          } catch {
            this.logger.warn(
              { correlationId, jobId, rawMessage: rawMessage.slice(0, 200) },
              'Received non-JSON message on Redis channel',
            );
            return;
          }

          if (message.type === 'done') {
            // Signal the stream end — complete without emitting (client already got complete/error)
            subscriber.complete();
            return;
          }

          subscriber.next({
            type: message.type,
            data: rawMessage,
          });
        },
      );

      // Teardown: called when client disconnects or Observable completes
      return () => {
        this.logger.debug(
          { correlationId, jobId },
          'SSE client disconnected — cleaning up Redis subscriber',
        );
        cleanup().catch((err: unknown) => {
          this.logger.error(
            { correlationId, jobId, error: String(err) },
            'Unhandled error during SSE teardown',
          );
        });
      };
    });
  }
}
