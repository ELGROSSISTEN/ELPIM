import { createHmac, timingSafeEqual } from 'node:crypto';

export const verifyStripeWebhook = (rawBody: string, signatureHeader: string | undefined, signingSecret: string): boolean => {
  if (!signatureHeader) {
    return false;
  }

  const elements = signatureHeader.split(',').map((part) => part.trim());
  const timestamp = elements.find((part) => part.startsWith('t='))?.slice(2);
  const signatures = elements.filter((part) => part.startsWith('v1=')).map((part) => part.slice(3));

  if (!timestamp || signatures.length === 0) {
    return false;
  }

  const payload = `${timestamp}.${rawBody}`;
  const expected = createHmac('sha256', signingSecret).update(payload).digest('hex');

  return signatures.some((sig) => {
    try {
      const expectedBuff = Buffer.from(expected, 'hex');
      const sigBuff = Buffer.from(sig, 'hex');
      return expectedBuff.length === sigBuff.length && timingSafeEqual(expectedBuff, sigBuff);
    } catch {
      return false;
    }
  });
};

export const createStripeSignatureHeaderForTest = (rawBody: string, signingSecret: string, timestamp = 1700000000): string => {
  const payload = `${timestamp}.${rawBody}`;
  const digest = createHmac('sha256', signingSecret).update(payload).digest('hex');
  return `t=${timestamp},v1=${digest}`;
};

export const isUniqueConstraintError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return lower.includes('unique') || lower.includes('duplicate');
};
