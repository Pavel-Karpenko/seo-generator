import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import type { RedisOptions } from 'ioredis';
import appConfig from './config/app.config';
import flowiseConfig from './config/flowise.config';
import redisConfig from './config/redis.config';
import { SeoModule } from './seo/seo.module';
import { QueueModule } from './queue/queue.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      load: [appConfig, flowiseConfig, redisConfig],
      cache: true,
    }),
    // BullMQ root connection must be registered before any queue module
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const redisUrl = configService.getOrThrow<string>('redis.url');
        const parsedUrl = new URL(redisUrl);
        const redisOptions =
          configService.get<RedisOptions>('redis.options') ?? {};
        return {
          connection: {
            host: parsedUrl.hostname,
            port: parseInt(parsedUrl.port || '6379', 10),
            password: parsedUrl.password || undefined,
            db: parsedUrl.pathname
              ? parseInt(parsedUrl.pathname.slice(1) || '0', 10)
              : 0,
            ...redisOptions,
          },
        };
      },
    }),
    QueueModule,
    SeoModule,
    HealthModule,
  ],
})
export class AppModule {}
