import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string(),
  JWT_SECRET: z.string().min(10),
  MASTER_ENCRYPTION_KEY: z.string().min(16),
  SHOPIFY_WEBHOOK_SECRET: z.string().min(3),
  SHOPIFY_WEBHOOK_CALLBACK_BASE_URL: z.string().url(),
  OPENAI_MODEL: z.string().default('gpt-4.1-mini'),
  APP_BASE_URL: z.string().url().optional(),
  CORS_ORIGINS: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  NOTIFY_EMAIL: z.string().optional(),
  ACCESS_CODE: z.string().min(4),
});

export const env = envSchema.parse(process.env);
