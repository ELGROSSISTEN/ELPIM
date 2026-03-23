import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from './config.js';

const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

export const syncQueue = new Queue('sync-jobs', { connection });
export const importQueue = new Queue('import-jobs', { connection });
export const aiQueue = new Queue('ai-jobs', { connection });
export const webhookQueue = new Queue('webhook-jobs', { connection });
export const feedCrawlQueue = new Queue('feed-crawl', { connection });
export const altTextQueue = new Queue('alt-text-jobs', { connection });
