import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

@Injectable()
export class CorrelationIdInterceptor implements NestInterceptor {
  private readonly logger = new Logger(CorrelationIdInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ctx = context.switchToHttp();
    const request = ctx.getRequest<Request & { correlationId?: string }>();
    const response = ctx.getResponse<Response>();

    // Reuse client-provided ID or generate a new one
    const correlationId =
      (request.headers[CORRELATION_ID_HEADER] as string | undefined) ??
      uuidv4();

    request.correlationId = correlationId;
    response.setHeader(CORRELATION_ID_HEADER, correlationId);

    this.logger.debug(
      { correlationId, path: request.url, method: request.method },
      'Request received',
    );

    return next.handle().pipe(
      tap({
        error: (err: unknown) => {
          this.logger.debug(
            { correlationId, error: String(err) },
            'Request completed with error',
          );
        },
      }),
    );
  }
}
