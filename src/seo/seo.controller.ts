import {
  Controller,
  Post,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UseInterceptors,
  Req,
  Sse,
  Logger,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { Request } from 'express';
import { CorrelationIdInterceptor } from '../common/interceptors/correlation-id.interceptor';
import { GenerateSeoDto } from './dto/generate-seo.dto';
import { SeoService } from './seo.service';

interface GenerateSeoResponse {
  jobId: string;
  streamUrl: string;
}

interface MessageEvent {
  data: string | object;
  id?: string;
  type?: string;
  retry?: number;
}

@Controller()
@UseInterceptors(CorrelationIdInterceptor)
export class SeoController {
  private readonly logger = new Logger(SeoController.name);

  constructor(private readonly seoService: SeoService) {}

  /**
   * POST /api/generate-seo
   * Validates the DTO, enqueues a BullMQ job, and immediately returns 202
   * with the jobId and the SSE stream URL to poll for results.
   */
  @Post('api/generate-seo')
  @HttpCode(HttpStatus.ACCEPTED)
  async generateSeo(
    @Body() dto: GenerateSeoDto,
    @Req() req: Request & { correlationId?: string },
  ): Promise<GenerateSeoResponse> {
    const correlationId = req.correlationId ?? 'n/a';

    this.logger.log(
      {
        correlationId,
        product_name: dto.product_name,
        category: dto.category,
        keywords: dto.keywords,
      },
      'Enqueuing SEO generation job',
    );

    const result = await this.seoService.enqueue(dto, correlationId);

    this.logger.log(
      { correlationId, jobId: result.jobId },
      'SEO generation job enqueued',
    );

    return result;
  }

  /**
   * GET /api/seo/:jobId/stream
   * Server-Sent Events endpoint. Subscribes to the Redis pub/sub channel
   * for the given jobId and forwards events to the client.
   * The Observable teardown (client disconnect) triggers cleanup.
   */
  @Sse('api/seo/:jobId/stream')
  streamSeo(
    @Param('jobId') jobId: string,
    @Req() req: Request & { correlationId?: string },
  ): Observable<MessageEvent> {
    const correlationId = req.correlationId ?? 'n/a';

    this.logger.log(
      { correlationId, jobId },
      'SSE stream connection established',
    );

    return this.seoService.createSseStream(jobId, correlationId);
  }
}
