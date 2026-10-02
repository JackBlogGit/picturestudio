import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CrawlerLink } from '../../entities';
import { CRAWLER_RUNNER, Crawl4AiRunner } from './crawl-runner';
import { CrawlerController } from './crawler.controller';
import { CrawlerService } from './crawler.service';

@Module({
  imports: [TypeOrmModule.forFeature([CrawlerLink])],
  controllers: [CrawlerController],
  providers: [CrawlerService, { provide: CRAWLER_RUNNER, useClass: Crawl4AiRunner }],
  exports: [CrawlerService],
})
export class CrawlerModule {}
