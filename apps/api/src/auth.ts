import bcrypt from 'bcrypt';

const BCRYPT_ROUNDS = 12;

export const hashPassword = async (password: string): Promise<string> =>
  bcrypt.hash(password, BCRYPT_ROUNDS);

export const verifyPassword = async (password: string, passwordHash: string): Promise<boolean> => {
  // Support legacy SHA-256 hashes (64 hex chars, no $2b$ prefix) for migration
  if (!passwordHash.startsWith('$2b$') && passwordHash.length === 64) {
    const { createHash } = await import('node:crypto');
    return createHash('sha256').update(password).digest('hex') === passwordHash;
  }
  return bcrypt.compare(password, passwordHash);
};
