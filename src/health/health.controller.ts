import { Controller, Get, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

interface ServiceStatus {
  status: 'ok' | 'error';
  latencyMs?: number;
  error?: string;
}

interface HealthResponse {
  status: 'ok' | 'degraded' | 'error';
  redis: ServiceStatus;
  flowise: ServiceStatus;
  uptime: number;
  timestamp: string;
}

const HEALTH_CHECK_TIMEOUT_MS = 5_000;

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly configService: ConfigService) {}

  @Get()
  async check(): Promise<HealthResponse> {
    const [redisStatus, flowiseStatus] = await Promise.all([
      this.checkRedis(),
      this.checkFlowise(),
    ]);

    const allOk = redisStatus.status === 'ok' && flowiseStatus.status === 'ok';
    const allError =
      redisStatus.status === 'error' && flowiseStatus.status === 'error';

    const overallStatus = allOk ? 'ok' : allError ? 'error' : 'degraded';

    return {
      status: overallStatus,
      redis: redisStatus,
      flowise: flowiseStatus,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  private async checkRedis(): Promise<ServiceStatus> {
    const redisUrl = this.configService.getOrThrow<string>('redis.url');
    const redisOptions = this.configService.get('redis.options') ?? {};

    const redis = new Redis(redisUrl, {
      ...redisOptions,
      lazyConnect: true,
      connectTimeout: HEALTH_CHECK_TIMEOUT_MS,
      maxRetriesPerRequest: 0,
    });

    const start = Date.now();
    try {
      await redis.connect();
      const pong = await redis.ping();
      const latencyMs = Date.now() - start;

      if (pong !== 'PONG') {
        return { status: 'error', error: `Unexpected PING response: ${pong}` };
      }

      return { status: 'ok', latencyMs };
    } catch (err: unknown) {
      const latencyMs = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn({ error: message }, 'Redis health check failed');
      return { status: 'error', latencyMs, error: message };
    } finally {
      redis.disconnect();
    }
  }

  private async checkFlowise(): Promise<ServiceStatus> {
    const baseUrl = this.configService.getOrThrow<string>('flowise.baseUrl');
    const pingUrl = `${baseUrl}/api/v1/ping`;

    const abortController = new AbortController();
    const timeoutHandle = setTimeout(
      () => abortController.abort(),
      HEALTH_CHECK_TIMEOUT_MS,
    );

    const start = Date.now();
    try {
      const response = await fetch(pingUrl, {
        method: 'GET',
        signal: abortController.signal,
      });
      const latencyMs = Date.now() - start;

      if (!response.ok) {
        return {
          status: 'error',
          latencyMs,
          error: `Flowise ping returned HTTP ${response.status}`,
        };
      }

      return { status: 'ok', latencyMs };
    } catch (err: unknown) {
      const latencyMs = Date.now() - start;
      const isTimeout =
        err instanceof Error &&
        (err.name === 'AbortError' || err.message.includes('aborted'));

      const message = isTimeout
        ? `Flowise ping timed out after ${HEALTH_CHECK_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : String(err);

      this.logger.warn({ error: message }, 'Flowise health check failed');
      return { status: 'error', latencyMs, error: message };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
