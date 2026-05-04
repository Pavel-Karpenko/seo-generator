import { Module } from '@nestjs/common';
import { FlowiseClient } from './flowise.client';

@Module({
  providers: [FlowiseClient],
  exports: [FlowiseClient],
})
export class FlowiseModule {}
