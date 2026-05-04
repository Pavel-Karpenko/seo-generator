import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { FlowiseModule } from '../flowise/flowise.module';
import { SeoProcessor } from './seo.processor';
import { SEO_QUEUE_NAME } from '../seo/seo.service';

@Module({
  imports: [
    // Root connection is registered in AppModule — just declare the queue here
    BullModule.registerQueue({ name: SEO_QUEUE_NAME }),
    FlowiseModule,
  ],
  providers: [SeoProcessor],
  exports: [BullModule],
})
export class QueueModule {}
