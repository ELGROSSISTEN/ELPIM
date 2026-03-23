import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';

const getKey = (masterKeyHex: string): Buffer => {
  const raw = Buffer.from(masterKeyHex, 'hex');
  if (raw.length === 32) {
    return raw;
  }
  return createHash('sha256').update(masterKeyHex).digest();
};

export const encryptSecret = (plaintext: string, masterKeyHex: string): string => {
  const key = getKey(masterKeyHex);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}.${tag.toString('hex')}.${encrypted.toString('hex')}`;
};

export const decryptSecret = (payload: string, masterKeyHex: string): string => {
  const [ivHex, tagHex, encryptedHex] = payload.split('.');
  if (!ivHex || !tagHex || !encryptedHex) {
    throw new Error('Invalid encrypted payload format');
  }
  const key = getKey(masterKeyHex);
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
};
