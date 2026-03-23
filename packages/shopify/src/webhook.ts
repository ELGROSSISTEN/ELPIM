import { createHmac, timingSafeEqual } from 'node:crypto';

export const verifyShopifyWebhook = (
  rawBody: string,
  hmacHeader: string | undefined,
  secret: string,
): boolean => {
  if (!hmacHeader) {
    return false;
  }
  const digest = createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  const left = Buffer.from(digest);
  const right = Buffer.from(hmacHeader);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
};
