import PQueue from 'p-queue';
import pino from 'pino';

export interface ShopifyClientConfig {
  storeUrl: string;
  adminToken: string;
  maxRetries?: number;
  minDelayMs?: number;
}

export class ShopifyGraphQLClient {
  private readonly endpoint: string;
  private readonly queue: PQueue;
  private readonly maxRetries: number;
  private readonly minDelayMs: number;
  private readonly logger = pino({ name: 'shopify-client' });

  constructor(config: ShopifyClientConfig) {
    this.endpoint = `${config.storeUrl}/admin/api/2025-01/graphql.json`;
    this.maxRetries = config.maxRetries ?? 5;
    this.minDelayMs = config.minDelayMs ?? 200;
    this.queue = new PQueue({ interval: 1000, intervalCap: 4, concurrency: 2 });
    this.headers = {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': config.adminToken,
    };
  }

  private readonly headers: Record<string, string>;

  async execute<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const result = await this.queue.add<T>(() => this.withRetry<T>(query, variables));
    if (result === undefined) {
      throw new Error('Shopify request queue returned no result');
    }
    return result;
  }

  private async withRetry<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let attempt = 0;
    let delay = this.minDelayMs;

    while (attempt <= this.maxRetries) {
      try {
        const response = await fetch(this.endpoint, {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify({ query, variables }),
        });

        if (!response.ok) {
          if (response.status === 429 || response.status >= 500) {
            throw new Error(`Retryable Shopify response status ${response.status}`);
          }
          const text = await response.text();
          throw new Error(`Shopify error ${response.status}: ${text}`);
        }

        const json = (await response.json()) as { data?: T; errors?: unknown };
        if (json.errors) {
          throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
        }
        if (!json.data) {
          throw new Error('Shopify response missing data');
        }
        return json.data;
      } catch (error) {
        attempt += 1;
        if (attempt > this.maxRetries) {
          throw error;
        }
        this.logger.warn({ error, attempt, delay }, 'retrying shopify request');
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      }
    }

    throw new Error('Unexpected retry loop termination');
  }
}
