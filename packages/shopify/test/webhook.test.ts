import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyShopifyWebhook } from '../src/webhook.js';

describe('verifyShopifyWebhook', () => {
  it('returns true for valid HMAC', () => {
    const secret = 'secret';
    const raw = JSON.stringify({ hello: 'world' });
    const hmac = createHmac('sha256', secret).update(raw).digest('base64');

    expect(verifyShopifyWebhook(raw, hmac, secret)).toBe(true);
  });

  it('returns false for invalid HMAC', () => {
    expect(verifyShopifyWebhook('{"x":1}', 'bad', 'secret')).toBe(false);
  });
});
