import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import pinoHttp from 'pino-http';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // Disable NestJS default logger — pino-http handles HTTP logs
    bufferLogs: true,
  });

  const configService = app.get(ConfigService);
  const port = configService.get<number>('app.port', 3000);
  const nodeEnv = configService.get<string>('app.nodeEnv', 'development');
  const logger = new Logger('Bootstrap');

  // Register pino-http middleware for structured request logging
  app.use(
    pinoHttp({
      level: nodeEnv === 'production' ? 'info' : 'debug',
      transport:
        nodeEnv !== 'production'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
      // Attach correlationId from request header to every log line
      customProps: (req) => ({
        correlationId: req.headers['x-correlation-id'] ?? 'n/a',
      }),
      // Redact sensitive fields from logs
      redact: {
        paths: ['req.headers.authorization', 'req.headers["x-api-key"]'],
        censor: '[REDACTED]',
      },
    }),
  );

  // Global DTO validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Global exception filter (logs with correlationId, returns structured errors)
  app.useGlobalFilters(new HttpExceptionFilter());

  // Enable CORS — adjust origins for production
  app.enableCors({
    origin: nodeEnv === 'production' ? false : true,
    methods: 'GET,HEAD,POST',
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-ID'],
    exposedHeaders: ['X-Correlation-ID'],
  });

  // Graceful shutdown: drain BullMQ workers before closing
  app.enableShutdownHooks();

  process.on('SIGTERM', async () => {
    logger.log('SIGTERM received — initiating graceful shutdown');
    setTimeout(() => {
      logger.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    await app.close();
    logger.log('Application closed gracefully');
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logger.log('SIGINT received — initiating graceful shutdown');
    await app.close();
    process.exit(0);
  });

  await app.listen(port);
  logger.log(`Application is running on port ${port} in ${nodeEnv} mode`);
}

bootstrap().catch((err: unknown) => {
  console.error('Fatal error during bootstrap:', err);
  process.exit(1);
});
