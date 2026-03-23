import { z } from 'zod';

export const env = z
  .object({
    DATABASE_URL: z.string(),
    REDIS_URL: z.string(),
    MASTER_ENCRYPTION_KEY: z.string().min(16),
    WORKER_HEALTH_PORT: z.coerce.number().default(4100),
    OPENAI_MODEL: z.string().default('gpt-4.1-mini'),
    DAILY_AI_SPEND_CAP_USD: z.coerce.number().default(25),
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().optional(),
    APP_BASE_URL: z.string().url().optional(),
  })
  .parse(process.env);
