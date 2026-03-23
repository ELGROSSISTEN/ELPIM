export const isUniqueConstraintError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return lower.includes('unique') || lower.includes('duplicate');
};
