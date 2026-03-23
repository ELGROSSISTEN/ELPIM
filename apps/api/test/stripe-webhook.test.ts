import { describe, expect, it } from 'vitest';
import {
  createStripeSignatureHeaderForTest,
  isUniqueConstraintError,
  verifyStripeWebhook,
} from '../src/stripe-utils.js';

describe('stripe webhook verification', () => {
  it('accepts valid signature header', () => {
    const raw = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' });
    const secret = 'whsec_test_secret';
    const header = createStripeSignatureHeaderForTest(raw, secret, 1700000000);

    expect(verifyStripeWebhook(raw, header, secret)).toBe(true);
  });

  it('rejects invalid signature header', () => {
    const raw = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' });
    const secret = 'whsec_test_secret';
    const invalidHeader = 't=1700000000,v1=deadbeef';

    expect(verifyStripeWebhook(raw, invalidHeader, secret)).toBe(false);
  });

  it('detects unique/duplicate errors for replay dedupe', () => {
    expect(isUniqueConstraintError(new Error('Unique constraint failed on the fields'))).toBe(true);
    expect(isUniqueConstraintError(new Error('duplicate key value violates unique constraint'))).toBe(true);
    expect(isUniqueConstraintError(new Error('network timeout'))).toBe(false);
  });

  it('rejects missing signature header', () => {
    const raw = JSON.stringify({ id: 'evt_missing_sig', type: 'invoice.paid' });
    expect(verifyStripeWebhook(raw, undefined, 'whsec_test_secret')).toBe(false);
  });
});
