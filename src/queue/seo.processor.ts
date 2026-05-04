import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import type { SeoResult } from '../seo/schemas/seo-result.schema';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { FlowiseClient } from '../flowise/flowise.client';
import {
  FlowiseTimeoutError,
  FlowiseApiError,
  FlowiseEmptyResponseError,
} from '../flowise/flowise.types';
import { extractAndValidate, SeoParseError } from '../seo/schemas/seo-result.schema';
import type { SeoJobData, SeoStreamMessage } from '../seo/seo.service';
import { SEO_QUEUE_NAME } from '../seo/seo.service';

const PROCESSOR_CONCURRENCY = 2;

@Processor(SEO_QUEUE_NAME, { concurrency: PROCESSOR_CONCURRENCY })
export class SeoProcessor extends WorkerHost {
  private readonly logger = new Logger(SeoProcessor.name);
  private readonly redis: Redis;
  private readonly redisUrl: string;

  constructor(
    private readonly flowiseClient: FlowiseClient,
    private readonly configService: ConfigService,
  ) {
    super();
    this.redisUrl = this.configService.getOrThrow<string>('redis.url');
    const redisOptions = this.configService.get('redis.options') ?? {};

    // Dedicated Redis connection for publishing (separate from queue connection)
    this.redis = new Redis(this.redisUrl, {
      ...redisOptions,
      lazyConnect: false,
    });

    this.redis.on('error', (err: Error) => {
      this.logger.error({ error: err.message }, 'Redis publisher connection error');
    });
  }

  /**
   * Main job processing method.
   * All error paths MUST publish a { type: 'error' } message followed by { type: 'done' }
   * so SSE clients are never left hanging.
   */
  async process(job: Job<SeoJobData>): Promise<SeoResult | undefined> {
    const { jobId, product_name, category, keywords, session_id, correlationId } =
      job.data;

    const channel = `seo:stream:${jobId}`;

    this.logger.log(
      {
        correlationId,
        jobId,
        jobAttempt: job.attemptsMade + 1,
        product_name,
        category,
      },
      'Processing SEO generation job',
    );

    await job.log(
      `[${new Date().toISOString()}] Starting SEO generation for "${product_name}"`,
    );

    const question = buildPromptQuestion(product_name, category, keywords);
    const tokenBuffer: string[] = [];

    try {
      // Stream tokens from Flowise, publish each one to Redis
      for await (const event of this.flowiseClient.streamPrediction(
        question,
        session_id,
        correlationId,
      )) {
        if (event.type === 'token' && event.data) {
          tokenBuffer.push(event.data);

          const tokenMessage: SeoStreamMessage = { type: 'token', data: event.data };
          await this.publishMessage(channel, tokenMessage, correlationId);
        } else if (event.type === 'error') {
          throw new FlowiseApiError(0, event.data);
        }
        // 'end' event — let loop finish naturally
      }

      const accumulated = tokenBuffer.join('');

      await job.log(
        `[${new Date().toISOString()}] Stream completed. Accumulated ${accumulated.length} characters. Validating...`,
      );

      this.logger.debug(
        { correlationId, jobId, accumulatedLength: accumulated.length },
        'Flowise stream complete, validating output',
      );

      // Parse and validate the accumulated LLM response
      const seoResult = extractAndValidate(accumulated);

      const completeMessage: SeoStreamMessage = {
        type: 'complete',
        data: seoResult,
      };
      await this.publishMessage(channel, completeMessage, correlationId);

      await job.log(
        `[${new Date().toISOString()}] SEO result validated and published successfully`,
      );

      this.logger.log(
        { correlationId, jobId },
        'SEO generation job completed successfully',
      );

      return seoResult;
    } catch (err: unknown) {
      const { code, message } = classifyError(err);

      this.logger.error(
        { correlationId, jobId, errorCode: code, error: message },
        'SEO generation job failed',
      );

      await job.log(
        `[${new Date().toISOString()}] Job failed: [${code}] ${message}`,
      );

      const errorMessage: SeoStreamMessage = {
        type: 'error',
        code,
        message,
      };
      await this.publishMessage(channel, errorMessage, correlationId);

      // Re-throw so BullMQ can apply retry logic
      throw err;
    } finally {
      // Always publish 'done' so SSE subscriber knows to close the stream
      const doneMessage: SeoStreamMessage = { type: 'done' };
      await this.publishMessage(channel, doneMessage, correlationId).catch(
        (publishErr: unknown) => {
          this.logger.error(
            { correlationId, jobId, error: String(publishErr) },
            'Failed to publish done message',
          );
        },
      );
    }
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job<SeoJobData>): void {
    this.logger.log(
      { jobId: job.data.jobId, correlationId: job.data.correlationId },
      `Job ${job.id} completed`,
    );
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<SeoJobData> | undefined, err: Error): void {
    if (!job) return;
    this.logger.error(
      {
        jobId: job.data.jobId,
        correlationId: job.data.correlationId,
        attemptsMade: job.attemptsMade,
        error: err.message,
      },
      `Job ${job.id} failed`,
    );
  }

  @OnWorkerEvent('error')
  onError(err: Error): void {
    this.logger.error({ error: err.message }, 'Worker error');
  }

  private async publishMessage(
    channel: string,
    message: SeoStreamMessage,
    correlationId: string,
  ): Promise<void> {
    try {
      await this.redis.publish(channel, JSON.stringify(message));
    } catch (err: unknown) {
      this.logger.error(
        { correlationId, channel, error: String(err) },
        'Failed to publish message to Redis',
      );
      throw err;
    }
  }
}

// ---- Helpers ----

function buildPromptQuestion(
  productName: string,
  category: string,
  keywords: string[],
): string {
  return (
    `Generate SEO content for the following product.\n` +
    `Product name: ${productName}\n` +
    `Category: ${category}\n` +
    `Keywords: ${keywords.join(', ')}\n\n` +
    `Remember: respond ONLY with valid JSON matching the required schema.`
  );
}

interface ErrorInfo {
  code: string;
  message: string;
}

function classifyError(err: unknown): ErrorInfo {
  if (err instanceof FlowiseTimeoutError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof FlowiseApiError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof FlowiseEmptyResponseError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof SeoParseError) {
    return { code: err.code, message: err.message };
  }
  if (err instanceof Error) {
    return { code: 'PROCESSING_ERROR', message: err.message };
  }
  return { code: 'UNKNOWN_ERROR', message: String(err) };
}
