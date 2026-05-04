import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { FlowiseModule } from '../flowise/flowise.module';
import { SeoController } from './seo.controller';
import { SeoService } from './seo.service';
import { SEO_QUEUE_NAME } from './seo.service';

@Module({
  imports: [
    BullModule.registerQueue({
      name: SEO_QUEUE_NAME,
    }),
    FlowiseModule,
  ],
  controllers: [SeoController],
  providers: [SeoService],
  exports: [SeoService],
})
export class SeoModule {}
