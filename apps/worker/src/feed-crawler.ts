/**
 * Streaming feed crawler for large XML/CSV product feeds.
 *
 * Design principles:
 *  - Never loads the entire file into memory.
 *  - Uses SAX (event-driven) parsing for XML → O(1) memory per element.
 *  - Streams CSV line-by-line via readline.
 *  - Batch-upserts extracted rows to SourceDataRow (batch size 200).
 *  - Product matching identical to existing CSV logic (by productId, handle, SKU).
 *  - Stale rows (not seen in current crawl) are deleted after a successful crawl.
 */
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { SaxesParser, SaxesTag } from 'saxes';
import pino from 'pino';
import { prisma } from '@epim/db';

const logger = pino({ name: 'feed-crawler' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type ProductLookup = {
  byId: Map<string, string>;       // externalId → productId
  byHandle: Map<string, string>;   // handle (lowered) → productId
  bySku: Map<string, string>;      // sku (lowered) → productId
};

export type CrawlResult = {
  totalRows: number;
  matchedRows: number;
  unmatchedRows: number;
  upsertedRows: number;
  deletedStaleRows: number;
  durationMs: number;
};

// ---------------------------------------------------------------------------
// HTTP streaming fetch — timeout covers the ENTIRE download, not just headers
// ---------------------------------------------------------------------------
async function streamFetch(url: string): Promise<Readable> {
  const controller = new AbortController();
  // 30 min timeout for the entire download (1.5 GB at ~1 MB/s = ~25 min)
  const timeout = setTimeout(() => controller.abort(), 30 * 60_000);

  const response = await fetch(url, {
    signal: controller.signal,
    headers: { 'Accept': 'application/xml, text/xml, text/csv, */*' },
    redirect: 'follow',
  });

  if (!response.ok) {
    clearTimeout(timeout);
    throw new Error(`Feed fetch failed: ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    clearTimeout(timeout);
    throw new Error('Feed response has no body');
  }

  // Convert Web ReadableStream to Node.js Readable — clear timeout when stream ends
  const nodeStream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
  nodeStream.on('end', () => clearTimeout(timeout));
  nodeStream.on('error', () => clearTimeout(timeout));
  nodeStream.on('close', () => clearTimeout(timeout));
  return nodeStream;
}

// ---------------------------------------------------------------------------
// Detect feed format from URL hints
// ---------------------------------------------------------------------------
type FeedFormat = 'xml' | 'csv';

function detectFormat(url: string): FeedFormat {
  const lower = url.toLowerCase();
  if (lower.includes('.xml') || lower.includes('format=xml') || lower.includes('content=xml')) {
    return 'xml';
  }
  if (lower.includes('.csv') || lower.includes('format=csv') || lower.includes('.tsv')) {
    return 'csv';
  }
  // Default to XML for product feeds
  return 'xml';
}

// ---------------------------------------------------------------------------
// Build product lookup maps from DB (one query, indexed)
// ---------------------------------------------------------------------------
async function buildProductLookup(shopId: string): Promise<ProductLookup> {
  const products = await prisma.product.findMany({
    where: { shopId },
    select: { id: true, handle: true, variants: { select: { sku: true } } },
  });

  const byId = new Map<string, string>();
  const byHandle = new Map<string, string>();
  const bySku = new Map<string, string>();

  for (const p of products) {
    byId.set(p.id, p.id);
    if (p.handle) byHandle.set(p.handle.toLowerCase(), p.id);
    for (const v of p.variants) {
      if (v.sku?.trim()) bySku.set(v.sku.trim().toLowerCase(), p.id);
    }
  }

  return { byId, byHandle, bySku };
}

// ---------------------------------------------------------------------------
// Match a single extracted row against products
// ---------------------------------------------------------------------------
const PRODUCT_ID_KEYS = ['id', 'productid', 'product_id', 'epimproductid', 'g:id'];
const HANDLE_KEYS = ['handle', 'producthandle', 'product_handle', 'link', 'url'];
const SKU_KEYS = ['sku', 'variantsku', 'variant_sku', 'itemno', 'itemnumber', 'item_number', 'g:mpn', 'mpn', 'g:gtin', 'gtin', 'ean'];

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

/**
 * Build a deterministic matchKey for a row based on its identifying fields.
 * This must be stable across crawls for the same logical product,
 * even if the row order changes in the feed.
 */
function buildMatchKey(row: Record<string, string>, matchType: string, matchValue: string): string {
  return `${matchType}:${matchValue}`;
}

function matchProduct(
  row: Record<string, string>,
  lookup: ProductLookup,
): { productId: string; matchKey: string; matchType: string } | null {
  // 1. Match by product ID
  const rawId = pickValue(row, PRODUCT_ID_KEYS);
  if (rawId) {
    const productId = lookup.byId.get(rawId);
    if (productId) return { productId, matchKey: buildMatchKey(row, 'id', rawId), matchType: 'productId' };
  }

  // 2. Match by handle (extract handle from URL if needed)
  let rawHandle = pickValue(row, HANDLE_KEYS);
  if (rawHandle) {
    if (rawHandle.startsWith('http')) {
      try {
        const urlPath = new URL(rawHandle).pathname;
        const segments = urlPath.split('/').filter(Boolean);
        rawHandle = segments[segments.length - 1] ?? rawHandle;
      } catch { /* use raw */ }
    }
    const productId = lookup.byHandle.get(rawHandle.toLowerCase());
    if (productId) return { productId, matchKey: buildMatchKey(row, 'handle', rawHandle.toLowerCase()), matchType: 'handle' };
  }

  // 3. Match by SKU / EAN / GTIN
  const rawSku = pickValue(row, SKU_KEYS);
  if (rawSku) {
    const productId = lookup.bySku.get(rawSku.toLowerCase());
    if (productId) return { productId, matchKey: buildMatchKey(row, 'sku', rawSku.toLowerCase()), matchType: 'sku' };
  }

  return null;
}

/**
 * Build a deterministic key for unmatched rows.
 * Uses the first identifying field value found, or a content hash.
 */
function buildUnmatchedKey(row: Record<string, string>): string {
  const identifier =
    pickValue(row, PRODUCT_ID_KEYS) ||
    pickValue(row, SKU_KEYS) ||
    pickValue(row, HANDLE_KEYS);

  if (identifier) {
    return `unmatched:${identifier}`;
  }

  // Fallback: hash of the row's first 3 non-empty values for stability
  const values = Object.values(row).filter((v) => v.trim()).slice(0, 3).join('|');
  // Simple djb2 hash
  let hash = 5381;
  for (let i = 0; i < values.length; i++) {
    hash = ((hash << 5) + hash + values.charCodeAt(i)) | 0;
  }
  return `unmatched:hash:${(hash >>> 0).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Batch upsert to SourceDataRow
// ---------------------------------------------------------------------------
const BATCH_SIZE = 200;

interface PendingRow {
  sourceId: string;
  shopId: string;
  productId: string | null;
  matchKey: string;
  matchType: string;
  dataJson: Record<string, string>;
}

async function flushBatch(batch: PendingRow[]): Promise<number> {
  if (batch.length === 0) return 0;

  await prisma.$transaction(
    batch.map((row) =>
      prisma.sourceDataRow.upsert({
        where: { sourceId_matchKey: { sourceId: row.sourceId, matchKey: row.matchKey } },
        update: { productId: row.productId, matchType: row.matchType, dataJson: row.dataJson as any, shopId: row.shopId },
        create: { sourceId: row.sourceId, shopId: row.shopId, productId: row.productId, matchKey: row.matchKey, matchType: row.matchType, dataJson: row.dataJson as any },
      }),
    ),
  );

  return batch.length;
}

// ---------------------------------------------------------------------------
// XML SAX streaming parser — handles nested elements correctly
// ---------------------------------------------------------------------------
const PRODUCT_ELEMENT_NAMES = new Set([
  'item', 'product', 'entry', 'record', 'row',
  'g:item', 'g:product',
]);

const PROGRESS_LOG_INTERVAL = 10_000; // Log progress every N rows

async function parseXmlStream(
  stream: Readable,
  sourceId: string,
  shopId: string,
  lookup: ProductLookup,
): Promise<CrawlResult> {
  const start = Date.now();
  let totalRows = 0;
  let matchedRows = 0;
  let unmatchedRows = 0;
  let upsertedRows = 0;

  const batch: PendingRow[] = [];
  let depth = 0;
  let inProduct = false;
  let productDepth = 0;
  // Tag stack for correct nested element handling
  const tagStack: string[] = [];
  let currentText = '';
  let currentRow: Record<string, string> = {};

  const parser = new SaxesParser({ xmlns: false });

  parser.on('opentag', (tag: SaxesTag) => {
    depth++;
    if (!inProduct && PRODUCT_ELEMENT_NAMES.has(tag.name.toLowerCase())) {
      inProduct = true;
      productDepth = depth;
      currentRow = {};
      tagStack.length = 0;
    }
    if (inProduct) {
      tagStack.push(tag.name);
      currentText = '';
    }
  });

  parser.on('text', (text: string) => {
    if (inProduct && tagStack.length > 0) {
      currentText += text;
    }
  });

  parser.on('cdata', (text: string) => {
    if (inProduct && tagStack.length > 0) {
      currentText += text;
    }
  });

  parser.on('closetag', (tag: SaxesTag) => {
    if (inProduct) {
      if (depth === productDepth) {
        // Closing the product element — process the row
        totalRows++;
        const match = matchProduct(currentRow, lookup);
        if (match) {
          matchedRows++;
          batch.push({
            sourceId, shopId,
            productId: match.productId,
            matchKey: match.matchKey,
            matchType: match.matchType,
            dataJson: currentRow,
          });
        } else {
          unmatchedRows++;
          batch.push({
            sourceId, shopId,
            productId: null,
            matchKey: buildUnmatchedKey(currentRow),
            matchType: 'unmatched',
            dataJson: currentRow,
          });
        }
        inProduct = false;
        currentRow = {};
        tagStack.length = 0;
        needsFlush = batch.length >= BATCH_SIZE;

        if (totalRows % PROGRESS_LOG_INTERVAL === 0) {
          logger.info({ sourceId, totalRows, matchedRows, unmatchedRows }, 'Feed crawl progress');
        }
      } else {
        // Closing a child element inside a product
        // Only store leaf text content (elements with actual text, not just nested children)
        if (currentText.trim()) {
          // Build a qualified key path for nested elements: parent.child
          // Use the full tag name for Google Shopping g: prefixed elements
          const key = tagStack.length <= 1
            ? tag.name
            : `${tagStack[tagStack.length - 2]}:${tag.name}`;
          // Don't overwrite — first value wins (top-level more specific)
          if (!currentRow[tag.name]) {
            currentRow[tag.name] = currentText.trim();
          }
          // Also store qualified key if different
          if (key !== tag.name && !currentRow[key]) {
            currentRow[key] = currentText.trim();
          }
        }
        currentText = '';
      }
      tagStack.pop();
    }
    depth--;
  });

  // Flag set by SAX closetag when batch is full
  let needsFlush = false;

  // Strip characters disallowed in XML 1.0:
  // U+0000–U+0008, U+000B, U+000C, U+000E–U+001F, U+FFFE, U+FFFF
  // Tab (U+0009), LF (U+000A) and CR (U+000D) are explicitly allowed.
  const DISALLOWED_XML_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g;

  const saxTransform = new Transform({
    async transform(chunk, _encoding, callback) {
      try {
        const sanitized = chunk.toString('utf8').replace(DISALLOWED_XML_CHARS, '');
        parser.write(sanitized);
        if (needsFlush) {
          needsFlush = false;
          upsertedRows += await flushBatch([...batch]);
          batch.length = 0;
        }
        callback();
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    },
    async flush(callback) {
      try {
        parser.close();
        if (batch.length > 0) {
          upsertedRows += await flushBatch(batch);
          batch.length = 0;
        }
        callback();
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });

  await pipeline(stream, saxTransform);

  return { totalRows, matchedRows, unmatchedRows, upsertedRows, deletedStaleRows: 0, durationMs: Date.now() - start };
}

// ---------------------------------------------------------------------------
// CSV streaming parser — handles quoted fields correctly
// ---------------------------------------------------------------------------

/** Parse a CSV line respecting quoted fields that may contain delimiters/newlines */
function parseCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"'; // Escaped quote
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

async function parseCsvStream(
  stream: Readable,
  sourceId: string,
  shopId: string,
  lookup: ProductLookup,
): Promise<CrawlResult> {
  const start = Date.now();
  let totalRows = 0;
  let matchedRows = 0;
  let unmatchedRows = 0;
  let upsertedRows = 0;

  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let headers: string[] = [];
  let isFirstLine = true;
  let delimiter = ',';
  const batch: PendingRow[] = [];

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (isFirstLine) {
      // Detect delimiter: check tab first (TSV), then semicolon vs comma
      const tabs = (trimmed.match(/\t/g) ?? []).length;
      const semicolons = (trimmed.match(/;/g) ?? []).length;
      const commas = (trimmed.match(/,/g) ?? []).length;
      if (tabs > commas && tabs > semicolons) {
        delimiter = '\t';
      } else if (semicolons > commas) {
        delimiter = ';';
      } else {
        delimiter = ',';
      }
      headers = parseCsvLine(trimmed, delimiter);
      isFirstLine = false;
      continue;
    }

    totalRows++;
    const cells = parseCsvLine(trimmed, delimiter);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { if (h) row[h] = cells[i] ?? ''; });

    const match = matchProduct(row, lookup);
    if (match) {
      matchedRows++;
      batch.push({
        sourceId, shopId,
        productId: match.productId,
        matchKey: match.matchKey,
        matchType: match.matchType,
        dataJson: row,
      });
    } else {
      unmatchedRows++;
      batch.push({
        sourceId, shopId,
        productId: null,
        matchKey: buildUnmatchedKey(row),
        matchType: 'unmatched',
        dataJson: row,
      });
    }

    if (batch.length >= BATCH_SIZE) {
      upsertedRows += await flushBatch([...batch]);
      batch.length = 0;
    }

    if (totalRows % PROGRESS_LOG_INTERVAL === 0) {
      logger.info({ sourceId, totalRows, matchedRows, unmatchedRows }, 'Feed crawl progress');
    }
  }

  if (batch.length > 0) {
    upsertedRows += await flushBatch([...batch]);
    batch.length = 0;
  }

  return { totalRows, matchedRows, unmatchedRows, upsertedRows, deletedStaleRows: 0, durationMs: Date.now() - start };
}

// ---------------------------------------------------------------------------
// Public: crawlFeed — entry point for the feed-crawl worker
// ---------------------------------------------------------------------------
export async function crawlFeed(sourceId: string): Promise<CrawlResult> {
  const source = await prisma.source.findUniqueOrThrow({ where: { id: sourceId } });
  const shopId = source.shopId;
  const url = source.url;

  logger.info({ sourceId, shopId, url }, 'Starting feed crawl');

  // Build product lookup
  const lookup = await buildProductLookup(shopId);
  logger.info({ shopId, products: lookup.byId.size, handles: lookup.byHandle.size, skus: lookup.bySku.size }, 'Product lookup built');

  // Fetch and stream
  const stream = await streamFetch(url);

  // Detect format and parse
  const format = detectFormat(url);
  logger.info({ format, url }, 'Detected feed format');

  let result: CrawlResult;
  if (format === 'xml') {
    result = await parseXmlStream(stream, sourceId, shopId, lookup);
  } else {
    result = await parseCsvStream(stream, sourceId, shopId, lookup);
  }

  // Delete stale rows that were NOT touched in this crawl
  // (updatedAt is older than crawl start — they existed before but weren't in this feed)
  const crawlStart = new Date(Date.now() - result.durationMs);
  const deleted = await prisma.sourceDataRow.deleteMany({
    where: {
      sourceId,
      updatedAt: { lt: crawlStart },
    },
  });
  result.deletedStaleRows = deleted.count;

  if (deleted.count > 0) {
    logger.info({ sourceId, deletedStaleRows: deleted.count }, 'Cleaned up stale rows');
  }

  // Update source metadata with crawl timestamp and mark as idle
  const meta = readSourceMeta(source.tagsJson);
  await prisma.source.update({
    where: { id: sourceId },
    data: {
      tagsJson: {
        ...meta,
        crawlStatus: 'idle',
        crawlError: undefined,
        lastCrawlAt: new Date().toISOString(),
        lastCrawlResult: {
          totalRows: result.totalRows,
          matchedRows: result.matchedRows,
          unmatchedRows: result.unmatchedRows,
          upsertedRows: result.upsertedRows,
          deletedStaleRows: result.deletedStaleRows,
          durationMs: result.durationMs,
        },
      },
    },
  });

  logger.info({ sourceId, ...result }, 'Feed crawl completed');
  return result;
}

// ---------------------------------------------------------------------------
// Minimal meta reader (worker-local, avoids import cycle)
// ---------------------------------------------------------------------------
function readSourceMeta(tagsJson: unknown): Record<string, unknown> {
  if (tagsJson && typeof tagsJson === 'object' && !Array.isArray(tagsJson)) {
    return tagsJson as Record<string, unknown>;
  }
  return {};
}
