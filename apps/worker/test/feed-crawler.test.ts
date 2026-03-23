import { describe, it, expect } from 'vitest';

// Test the CSV line parser and matching logic in isolation
// We re-implement the pure functions here since they're not exported

function parseCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === delimiter) {
        fields.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[\s_-]+/g, '').replace(/^g:/, '');
}

function pickValue(row: Record<string, string>, candidates: string[]): string {
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeKey(candidate);
    for (const [key, value] of Object.entries(row)) {
      if (normalizeKey(key) === normalizedCandidate && value.trim()) {
        return value.trim();
      }
    }
  }
  return '';
}

function buildUnmatchedKey(row: Record<string, string>): string {
  const PRODUCT_ID_KEYS = ['id', 'productid', 'product_id', 'epimproductid', 'g:id'];
  const SKU_KEYS = ['sku', 'variantsku', 'variant_sku', 'itemno', 'itemnumber', 'item_number', 'g:mpn', 'mpn', 'g:gtin', 'gtin', 'ean'];
  const HANDLE_KEYS = ['handle', 'producthandle', 'product_handle', 'link', 'url'];

  const identifier = pickValue(row, PRODUCT_ID_KEYS) || pickValue(row, SKU_KEYS) || pickValue(row, HANDLE_KEYS);
  if (identifier) return `unmatched:${identifier}`;

  const values = Object.values(row).filter((v) => v.trim()).slice(0, 3).join('|');
  let hash = 5381;
  for (let i = 0; i < values.length; i++) {
    hash = ((hash << 5) + hash + values.charCodeAt(i)) | 0;
  }
  return `unmatched:hash:${(hash >>> 0).toString(36)}`;
}

describe('parseCsvLine', () => {
  it('splits basic comma-delimited line', () => {
    expect(parseCsvLine('a,b,c', ',')).toEqual(['a', 'b', 'c']);
  });

  it('handles quoted fields with commas inside', () => {
    expect(parseCsvLine('"Hello, World",foo,bar', ',')).toEqual(['Hello, World', 'foo', 'bar']);
  });

  it('handles escaped quotes inside quoted fields', () => {
    expect(parseCsvLine('"He said ""hello""",b', ',')).toEqual(['He said "hello"', 'b']);
  });

  it('handles semicolon delimiter', () => {
    expect(parseCsvLine('a;b;c', ';')).toEqual(['a', 'b', 'c']);
  });

  it('handles empty fields', () => {
    expect(parseCsvLine('a,,c', ',')).toEqual(['a', '', 'c']);
  });

  it('handles tab delimiter', () => {
    expect(parseCsvLine('a\tb\tc', '\t')).toEqual(['a', 'b', 'c']);
  });

  it('trims whitespace from fields', () => {
    expect(parseCsvLine('  a , b , c  ', ',')).toEqual(['a', 'b', 'c']);
  });
});

describe('normalizeKey', () => {
  it('normalizes casing and separators', () => {
    expect(normalizeKey('Product_ID')).toBe('productid');
    expect(normalizeKey('product-id')).toBe('productid');
    expect(normalizeKey('  SKU  ')).toBe('sku');
  });

  it('strips g: prefix', () => {
    expect(normalizeKey('g:id')).toBe('id');
    expect(normalizeKey('g:mpn')).toBe('mpn');
  });
});

describe('pickValue', () => {
  it('finds value by normalized key', () => {
    const row = { 'Product_ID': '123', 'Title': 'Test' };
    expect(pickValue(row, ['productid', 'id'])).toBe('123');
  });

  it('skips empty values', () => {
    const row = { 'id': '', 'sku': 'ABC' };
    expect(pickValue(row, ['id', 'sku'])).toBe('ABC');
  });

  it('returns empty string when no match', () => {
    const row = { 'title': 'Test' };
    expect(pickValue(row, ['id', 'sku'])).toBe('');
  });
});

describe('buildUnmatchedKey', () => {
  it('uses identifier if available', () => {
    expect(buildUnmatchedKey({ id: 'ext-123', title: 'Test' })).toBe('unmatched:ext-123');
    expect(buildUnmatchedKey({ sku: 'SKU-456', title: 'Test' })).toBe('unmatched:SKU-456');
  });

  it('produces deterministic hash for same content', () => {
    const row = { title: 'Test Product', color: 'Red', size: 'L' };
    const key1 = buildUnmatchedKey(row);
    const key2 = buildUnmatchedKey(row);
    expect(key1).toBe(key2);
    expect(key1).toMatch(/^unmatched:hash:/);
  });

  it('produces different hash for different content', () => {
    const row1 = { title: 'Product A', color: 'Red' };
    const row2 = { title: 'Product B', color: 'Blue' };
    expect(buildUnmatchedKey(row1)).not.toBe(buildUnmatchedKey(row2));
  });
});
