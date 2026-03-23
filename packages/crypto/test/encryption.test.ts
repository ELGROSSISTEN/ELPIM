import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../src/index.js';

describe('encryptSecret/decryptSecret', () => {
  it('round-trips plaintext', () => {
    const key = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const plaintext = 'shpat_demo_token';

    const encrypted = encryptSecret(plaintext, key);
    const decrypted = decryptSecret(encrypted, key);

    expect(decrypted).toBe(plaintext);
    expect(encrypted).not.toBe(plaintext);
  });
});
