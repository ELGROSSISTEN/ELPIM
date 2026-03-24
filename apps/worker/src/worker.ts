import { Job, Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import pino from 'pino';
import { createServer } from 'node:http';
import { prisma } from '@epim/db';
import { decryptSecret } from '@epim/crypto';
import { monthKeyFromDateUtc, shouldEmitIncludedReachedNotice, shouldEmitOverageStartedNotice } from '@epim/shared';
import { ShopifyGraphQLClient } from '@epim/shopify';
import { getFieldValueRelationIds } from './ai-field-relations.js';
import { crawlFeed } from './feed-crawler.js';
import { env } from './config.js';

// --- Shopify rich text conversion ---
function htmlToShopifyRichText(html: string): Record<string, unknown> {
  type RichNode = Record<string, unknown>;

  const decode = (s: string) =>
    s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(+n));

  // Tokenize
  type Token =
    | { kind: 'open'; tag: string; attrs: string }
    | { kind: 'close'; tag: string }
    | { kind: 'selfclose'; tag: string }
    | { kind: 'text'; text: string };

  const tokens: Token[] = [];
  const tokenRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)>|([^<]+)/g;
  let tm: RegExpExecArray | null;
  while ((tm = tokenRe.exec(html)) !== null) {
    const [, slash, tag, attrs, selfSlash, text] = tm;
    if (text !== undefined) {
      tokens.push({ kind: 'text', text });
    } else if (slash) {
      tokens.push({ kind: 'close', tag: (tag ?? '').toLowerCase() });
    } else if (selfSlash) {
      tokens.push({ kind: 'selfclose', tag: (tag ?? '').toLowerCase() });
    } else {
      tokens.push({ kind: 'open', tag: (tag ?? '').toLowerCase(), attrs: attrs ?? '' });
    }
  }

  const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'div', 'blockquote', 'section', 'article', 'header', 'footer', 'main']);

  let i = 0;

  // Collect inline nodes until closing tag.
  // allowNestedBlocks: when true, dives into nested <p>/<div> etc. instead of stopping.
  function collectInlines(endTag?: string, allowNestedBlocks = false): RichNode[] {
    const inlines: RichNode[] = [];
    let bold = false;
    let italic = false;

    while (i < tokens.length) {
      const tok = tokens[i]!;

      if (tok.kind === 'close' && tok.tag === endTag) { i++; break; }
      if (tok.kind === 'close' && BLOCK_TAGS.has(tok.tag)) break;

      // When nested blocks are allowed (e.g. inside <li>), dive into them and collect their inlines
      if (tok.kind === 'open' && BLOCK_TAGS.has(tok.tag)) {
        if (allowNestedBlocks) {
          const nestedTag = tok.tag;
          i++;
          const nestedInlines = collectInlines(nestedTag, true);
          if (nestedInlines.length) {
            if (inlines.length) inlines.push({ type: 'text', value: ' ' });
            inlines.push(...nestedInlines);
          }
          continue;
        }
        break;
      }

      if (tok.kind === 'open' && (tok.tag === 'strong' || tok.tag === 'b')) { bold = true; i++; continue; }
      if (tok.kind === 'open' && (tok.tag === 'em' || tok.tag === 'i')) { italic = true; i++; continue; }
      if (tok.kind === 'close' && (tok.tag === 'strong' || tok.tag === 'b')) { bold = false; i++; continue; }
      if (tok.kind === 'close' && (tok.tag === 'em' || tok.tag === 'i')) { italic = false; i++; continue; }

      if ((tok.kind === 'selfclose' || tok.kind === 'open') && tok.tag === 'br') {
        inlines.push({ type: 'text', value: '\n' });
        i++; continue;
      }

      if (tok.kind === 'text') {
        const val = decode(tok.text).replace(/\n+/g, ' ');
        if (val.trim()) {
          const node: RichNode = { type: 'text', value: val };
          if (bold) node.bold = true;
          if (italic) node.italic = true;
          inlines.push(node);
        }
        i++; continue;
      }

      i++; // skip unknown tags
    }
    return inlines;
  }

  const blocks: RichNode[] = [];

  while (i < tokens.length) {
    const tok = tokens[i]!;

    if (tok.kind === 'text') {
      const val = decode(tok.text).trim();
      if (val) blocks.push({ type: 'paragraph', children: [{ type: 'text', value: val }] });
      i++;
    } else if (tok.kind === 'open' && tok.tag.match(/^h[1-6]$/)) {
      const level = parseInt(tok.tag[1]!);
      const endTag = tok.tag;
      i++;
      const inlines = collectInlines(endTag);
      if (inlines.length) blocks.push({ type: 'heading', level, children: inlines });
    } else if (tok.kind === 'open' && tok.tag === 'p') {
      i++;
      const inlines = collectInlines('p');
      if (inlines.length) blocks.push({ type: 'paragraph', children: inlines });
    } else if (tok.kind === 'open' && tok.tag === 'blockquote') {
      i++;
      const inlines = collectInlines('blockquote');
      if (inlines.length) blocks.push({ type: 'paragraph', children: inlines });
    } else if (tok.kind === 'open' && (tok.tag === 'ul' || tok.tag === 'ol')) {
      const listType = tok.tag === 'ol' ? 'ordered' : 'unordered';
      const listEndTag = tok.tag;
      i++;
      const items: RichNode[] = [];
      while (i < tokens.length) {
        const ltok = tokens[i]!;
        if (ltok.kind === 'close' && ltok.tag === listEndTag) { i++; break; }
        if (ltok.kind === 'open' && ltok.tag === 'li') {
          i++;
          const inlines = collectInlines('li', true); // dive into nested <p> etc.
          if (inlines.length) items.push({ type: 'list-item', children: inlines });
        } else {
          i++;
        }
      }
      if (items.length) blocks.push({ type: 'list', listType, children: items });
    } else {
      i++; // skip wrapper/unknown tags
    }
  }

  if (blocks.length === 0) {
    blocks.push({ type: 'paragraph', children: [{ type: 'text', value: '' }] });
  }

  return { type: 'root', children: blocks };
}

// --- CSV/source parsing helpers (kept local for worker isolation) ---
const workerNormalizeHeader = (v: string): string => v.trim().toLowerCase().replace(/\s+/g, '').replace(/[-_]/g, '');

const workerCleanCsvCell = (v: string): string => {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1).trim();
  return t;
};

const workerParseCsvRows = (csv: string): Array<Record<string, string>> => {
  const lines = csv.split('\n').map((l) => l.replace(/\r/g, '')).filter((l) => l.trim().length > 0);
  if (!lines.length) return [];
  const headerLine = lines[0] ?? '';
  const delimiter = (headerLine.match(/;/g) ?? []).length > (headerLine.match(/,/g) ?? []).length ? ';' : ',';
  const headers = headerLine.split(delimiter).map((h) => workerNormalizeHeader(workerCleanCsvCell(h)));
  return lines.slice(1).map((line) => {
    const cells = line.split(delimiter).map((c) => workerCleanCsvCell(c));
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { if (h) row[h] = cells[i] ?? ''; });
    return row;
  });
};

const workerPickCell = (row: Record<string, string>, keys: string[]): string => {
  for (const key of keys) {
    const val = row[workerNormalizeHeader(key)];
    if (val?.trim()) return val.trim();
  }
  return '';
};

type WorkerSourceMeta = {
  type: 'web' | 'products' | 'product_feed' | 'live_lookup';
  feedType?: 'live_url' | 'static_file';
  csv?: string;
  promptTemplate?: string;
  fieldMappings?: Array<{ csvColumn: string; fieldDefinitionId: string }>;
};

const DEFAULT_MASTER_PROMPT = `Du er en senior e-commerce copywriter og PIM-specialist med dyb forståelse for konverteringsoptimering og SEO.

Du modtager produktdata og genererer præcis den feltværdi der er anmodet om:
- faktuel og præcis baseret udelukkende på de givne data
- kommercielt stærk: sælger fordele, ikke blot features
- SEO-optimeret med naturligt, flydende sprog
- skrevet på dansk i et klart og professionelt sprog
- fri for overdrivelser, generiske floskler og usande påstande

Regler:
1) Brug kun data der er givet — opfind ALDRIG tekniske specifikationer, tal eller egenskaber der ikke er eksplicit angivet.
2) Mangler der data til et felt, skriv hellere ingenting frem for at gætte eller hallucinere.
3) Sæt kunden i centrum: hvad får de ud af det? Hvad løser produktet?
4) Undgå generiske vendinger som "høj kvalitet", "fantastisk produkt", "perfekt til".
5) Skriv konkret, præcist og letlæseligt.
6) Returnér kun den endelige feltværdi — ingen forklaringer, ingen overskrifter, ingen præambel.`;

const workerReadSourceMeta = (tagsJson: unknown): WorkerSourceMeta => {
  if (tagsJson && typeof tagsJson === 'object' && !Array.isArray(tagsJson)) {
    const r = tagsJson as Record<string, unknown>;
    const type = r.type === 'products' ? 'products' : r.type === 'product_feed' ? 'product_feed' : r.type === 'live_lookup' ? 'live_lookup' : 'web';
    const feedType = typeof r.feedType === 'string' ? (r.feedType as WorkerSourceMeta['feedType']) : undefined;
    const csv = typeof r.csv === 'string' ? r.csv : undefined;
    const promptTemplate = typeof r.promptTemplate === 'string' ? r.promptTemplate : undefined;
    const fieldMappings = Array.isArray(r.fieldMappings)
      ? r.fieldMappings.filter(
          (m): m is { csvColumn: string; fieldDefinitionId: string } =>
            typeof m === 'object' && m !== null &&
            typeof (m as any).csvColumn === 'string' &&
            typeof (m as any).fieldDefinitionId === 'string',
        )
      : undefined;
    return { type, feedType, csv, promptTemplate, ...(fieldMappings?.length ? { fieldMappings } : {}) };
  }
  return { type: 'web' };
};

/** Find the first matching CSV row for a product across all active product sources */
const findSupplierRowsForProduct = (
  sources: Array<{ name: string; tagsJson: unknown }>,
  product: { id: string; title: string; handle: string; vendor?: string | null; variants: Array<{ sku?: string | null }> },
): Array<{ sourceName: string; promptTemplate?: string; rowData: Record<string, string> }> => {
  const results: Array<{ sourceName: string; promptTemplate?: string; rowData: Record<string, string> }> = [];

  for (const source of sources) {
    const meta = workerReadSourceMeta(source.tagsJson);
    const hasStaticCsv = (meta.type === 'products' || meta.feedType === 'static_file') && meta.csv;
    if (!hasStaticCsv || !meta.csv) continue;

    const rows = workerParseCsvRows(meta.csv);
    const bySku = new Map<string, Record<string, string>>();
    const byHandle = new Map<string, Record<string, string>>();
    const byId = new Map<string, Record<string, string>>();

    for (const row of rows) {
      const rId = workerPickCell(row, ['productid', 'id', 'epimproductid']);
      if (rId) byId.set(rId, row);
      const rHandle = workerPickCell(row, ['handle', 'producthandle']);
      if (rHandle) byHandle.set(rHandle.toLowerCase(), row);
      const rSku = workerPickCell(row, ['sku', 'variantsku', 'itemno', 'itemnumber']);
      if (rSku) bySku.set(rSku.toLowerCase(), row);
    }

    const matchedRow =
      byId.get(product.id) ??
      byHandle.get(product.handle.toLowerCase()) ??
      product.variants.reduce<Record<string, string> | undefined>((found, v) => {
        if (found) return found;
        const sku = v.sku?.trim().toLowerCase();
        return sku ? bySku.get(sku) : undefined;
      }, undefined);

    if (matchedRow) {
      const meta = workerReadSourceMeta(source.tagsJson);
      results.push({ sourceName: source.name, promptTemplate: meta.promptTemplate, rowData: matchedRow });
    }
  }

  return results;
};

/** Find source data rows from the DB (for live_url feeds crawled by feed-crawler) */
const findCrawledSourceRows = async (
  sources: Array<{ id?: string; name: string; tagsJson: unknown }>,
  productId: string,
): Promise<Array<{ sourceName: string; promptTemplate?: string; rowData: Record<string, string> }>> => {
  const results: Array<{ sourceName: string; promptTemplate?: string; rowData: Record<string, string> }> = [];

  // Only check sources that are live_url (crawled) and have an ID
  const liveUrlSources = sources.filter((s) => {
    const meta = workerReadSourceMeta(s.tagsJson);
    return (meta.feedType === 'live_url' || (meta.type === 'web' && !meta.csv)) && 'id' in s && s.id;
  });

  if (liveUrlSources.length === 0) return results;

  const sourceIds = liveUrlSources.map((s) => (s as { id: string }).id);

  const dataRows = await prisma.sourceDataRow.findMany({
    where: {
      sourceId: { in: sourceIds },
      productId,
    },
    select: { sourceId: true, dataJson: true },
  });

  for (const row of dataRows) {
    const source = liveUrlSources.find((s) => (s as { id: string }).id === row.sourceId);
    if (!source) continue;
    const meta = workerReadSourceMeta(source.tagsJson);
    const data = row.dataJson as Record<string, string>;
    results.push({ sourceName: source.name, promptTemplate: meta.promptTemplate, rowData: data });
  }

  return results;
};
/** Flatten a JSON value one level deep into string key-value pairs */
const flattenJsonToStrings = (obj: unknown): Record<string, string> => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return typeof obj === 'string' ? { value: obj } : {};
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object' && !Array.isArray(value)) {
      for (const [nk, nv] of Object.entries(value)) {
        if (nv !== null && nv !== undefined) result[`${key}_${nk}`] = String(nv);
      }
    } else if (Array.isArray(value)) {
      result[key] = (value as unknown[]).map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(', ');
    } else {
      result[key] = String(value);
    }
  }
  return result;
};

/** Perform real-time HTTP lookups for live_lookup sources (at generation time, per product) */
const fetchLiveLookupRows = async (
  sources: Array<{ id?: string; name: string; tagsJson: unknown; url: string }>,
  variables: Record<string, string>,
): Promise<Array<{ sourceName: string; promptTemplate?: string; rowData: Record<string, string> }>> => {
  const results: Array<{ sourceName: string; promptTemplate?: string; rowData: Record<string, string> }> = [];
  const lookupSources = sources.filter((s) => workerReadSourceMeta(s.tagsJson).type === 'live_lookup');
  if (lookupSources.length === 0) return results;

  for (const source of lookupSources) {
    const meta = workerReadSourceMeta(source.tagsJson);
    // Replace {{variable}} placeholders in URL template
    const resolvedUrl = source.url.replace(/\{\{(\w+)\}\}/g, (_: string, key: string) =>
      encodeURIComponent(variables[key] ?? ''),
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(resolvedUrl, {
        signal: controller.signal,
        headers: { Accept: 'application/json, text/plain, */*' },
      });
      clearTimeout(timeout);
      if (!response.ok) {
        logger.warn({ sourceId: source.id, url: resolvedUrl, status: response.status }, 'Live lookup HTTP error — skipping');
        continue;
      }
      const contentType = response.headers.get('content-type') ?? '';
      let rowData: Record<string, string>;
      if (contentType.includes('application/json') || contentType.includes('text/json')) {
        const json = await response.json() as unknown;
        rowData = flattenJsonToStrings(json);
      } else {
        const text = await response.text();
        rowData = { response_text: text.slice(0, 3000) };
      }
      results.push({ sourceName: source.name, promptTemplate: meta.promptTemplate, rowData });
    } catch {
      clearTimeout(timeout);
      logger.warn({ sourceId: source.id, url: resolvedUrl }, 'Live lookup fetch failed — skipping');
    }
  }
  return results;
};

// --- end source helpers ---

const logger = pino({ name: 'worker' });
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const USD_TO_DKK = 6.9;
// gpt-4.1-mini pricing (updated 2026-03): $0.40/M input, $1.60/M output
const OPENAI_INPUT_USD_PER_1K = 0.0004;
const OPENAI_OUTPUT_USD_PER_1K = 0.0016;
// web_search_preview tool: $25 per 1000 calls = $0.025/call
const OPENAI_WEB_SEARCH_USD_PER_CALL = 0.025;

const estimateOpenAiCost = (promptTokens: number, completionTokens: number, webSearchCalls = 0): { usd: number; dkk: number } => {
  const usd =
    (promptTokens / 1000) * OPENAI_INPUT_USD_PER_1K +
    (completionTokens / 1000) * OPENAI_OUTPUT_USD_PER_1K +
    webSearchCalls * OPENAI_WEB_SEARCH_USD_PER_CALL;
  return { usd, dkk: usd * USD_TO_DKK };
};

const checkDailyAiSpendCap = async (shopId: string): Promise<void> => {
  const cap = env.DAILY_AI_SPEND_CAP_USD;
  if (!cap || cap <= 0) return;
  const delegate = (prisma as unknown as { aiUsage?: { aggregate: (args: unknown) => Promise<{ _sum?: { estimatedCostUsd?: number | null } }> } }).aiUsage;
  if (!delegate?.aggregate) return; // table not yet migrated; skip check
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const agg = await delegate.aggregate({
    where: { shopId, createdAt: { gte: startOfDay } },
    _sum: { estimatedCostUsd: true },
  });
  const spentUsd = agg._sum?.estimatedCostUsd ?? 0;
  if (spentUsd >= cap) {
    throw new Error(
      `Daily AI spend cap of $${cap} USD reached (today: $${spentUsd.toFixed(2)} USD). ` +
      `Job halted to prevent runaway cost. Raise DAILY_AI_SPEND_CAP_USD or wait until UTC midnight.`,
    );
  }
};

const createAiUsageSafe = async (data: {
  shopId: string;
  productId?: string | null;
  userId?: string | null;
  feature: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  estimatedCostDkk: number;
  metadataJson: Record<string, unknown>;
}): Promise<void> => {
  const delegate = (prisma as unknown as { aiUsage?: { create: (args: { data: unknown }) => Promise<unknown> } }).aiUsage;
  if (!delegate?.create) {
    logger.warn('aiUsage delegate unavailable; skipping ai usage logging');
    return;
  }

  try {
    await delegate.create({ data });
  } catch (error) {
    logger.warn({ error }, 'failed to persist ai usage log; continuing job');
  }
};

const createUsageEventSafe = async (data: {
  shopId: string;
  occurredAt: Date;
  monthKey: string;
  idempotencyKey: string;
  quantity: number;
  metadataJson: Record<string, unknown>;
}): Promise<{ created: boolean }> => {
  const delegate = (prisma as unknown as {
    usageEvent?: {
      create: (args: {
        data: {
          shopId: string;
          type: 'ai_datapoint_generated';
          quantity: number;
          occurredAt: Date;
          billingMonth: string;
          idempotencyKey: string;
          metadataJson: Record<string, unknown>;
        };
      }) => Promise<unknown>;
    };
  }).usageEvent;

  if (!delegate?.create) {
    logger.warn('usageEvent delegate unavailable; skipping usage event metering');
    return { created: false };
  }

  try {
    await delegate.create({
      data: {
        shopId: data.shopId,
        type: 'ai_datapoint_generated',
        quantity: data.quantity,
        occurredAt: data.occurredAt,
        billingMonth: data.monthKey,
        idempotencyKey: data.idempotencyKey,
        metadataJson: data.metadataJson,
      },
    });

    return { created: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.toLowerCase().includes('unique') || message.toLowerCase().includes('duplicate')) {
      logger.info({ idempotencyKey: data.idempotencyKey }, 'usage event already exists; skipping duplicate metering');
      return { created: false };
    }

    logger.warn({ error }, 'failed to persist usage event; continuing job');
    return { created: false };
  }
};

const sendUsageNoticeEmail = async (args: {
  recipients: string[];
  subject: string;
  html: string;
}): Promise<void> => {
  if (!args.recipients.length) {
    return;
  }

  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    logger.info({ recipients: args.recipients, subject: args.subject }, 'email config missing; skipping email send');
    return;
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: args.recipients,
        subject: args.subject,
        html: args.html,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      logger.warn({ status: response.status, text }, 'failed sending usage notice email');
    }
  } catch (error) {
    logger.warn({ error }, 'usage notice email threw');
  }
};

const createUsageNoticeIfMissing = async (args: {
  shopId: string;
  monthKey: string;
  kind: 'included_reached_100' | 'overage_started';
  consumedUnits: number;
  includedUnits: number;
}): Promise<void> => {
  const delegate = (prisma as unknown as {
    usageNotice?: {
      findUnique: (args: { where: { shopId_monthKey_kind: { shopId: string; monthKey: string; kind: string } } }) => Promise<unknown>;
      create: (args: { data: { shopId: string; monthKey: string; kind: string } }) => Promise<unknown>;
    };
    shop?: {
      findUnique: (args: {
        where: { id: string };
        include: {
          organization: {
            include: {
              memberships: {
                where: { role: { in: string[] } };
                include: { user: { select: { email: true } } };
              };
            };
          };
        };
      }) => Promise<any>;
    };
  }).usageNotice;

  if (!delegate) {
    return;
  }

  const existing = await delegate.findUnique({
    where: {
      shopId_monthKey_kind: {
        shopId: args.shopId,
        monthKey: args.monthKey,
        kind: args.kind,
      },
    },
  });

  if (existing) {
    return;
  }

  await delegate.create({
    data: {
      shopId: args.shopId,
      monthKey: args.monthKey,
      kind: args.kind,
    },
  });

  const shopDelegate = (prisma as any).shop;
  if (!shopDelegate?.findUnique) {
    return;
  }

  const shop = await shopDelegate.findUnique({
    where: { id: args.shopId },
    include: {
      organization: {
        include: {
          memberships: {
            where: { role: { in: ['owner', 'admin'] } },
            include: { user: { select: { email: true } } },
          },
        },
      },
    },
  });

  const recipients = (shop?.organization?.memberships ?? [])
    .map((membership: any) => membership.user?.email)
    .filter((email: unknown): email is string => typeof email === 'string' && email.length > 0);

  if (!recipients.length) {
    return;
  }

  const overageText = args.kind === 'overage_started'
    ? '<p>Gratis grænse er overskredet. Nye AI-genererede datapunkter faktureres nu som overforbrug.</p>'
    : '';

  await sendUsageNoticeEmail({
    recipients,
    subject: args.kind === 'overage_started' ? 'EL-PIM: Overforbrug af AI datapunkter er startet' : 'EL-PIM: 100/100 inkluderede AI datapunkter er brugt',
    html: `<p>Hej,</p><p>Shoppen har brugt <strong>${args.consumedUnits}</strong> AI-genererede datapunkter i ${args.monthKey}.</p><p>Inkluderet i abonnementet: <strong>${args.includedUnits}</strong>.</p>${overageText}<p>Du kan følge forbrug i EL-PIM under abonnement/forbrug.</p>${env.APP_BASE_URL ? `<p><a href="${env.APP_BASE_URL}">Gå til EL-PIM</a></p>` : ''}`,
  });
};

type SyncJobRef = { syncJobId: string };
type AiJobRef = { syncJobId: string; userId: string };

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const renderPrompt = (template: string, variables: Record<string, string>): string => {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    const token = new RegExp(`\\{\\{\\s*${escapeRegExp(key)}\\s*\\}\\}`, 'gi');
    result = result.replace(token, value);
  }
  return result;
};

const stripMarkdownCodeFences = (value: string): string => {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```[\w-]*\s*\n([\s\S]*?)\n```$/);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  return trimmed.replace(/^```[\w-]*\s*\n?/g, '').replace(/\n?```$/g, '').trim();
};

const buildDueDiligencePrompt = (args: {
  renderedPrompt: string;
  competitorUrls: string[];
  variables: Record<string, string>;
}): string => {
  const competitorBlock = args.competitorUrls.length
    ? `\nKONKURRENT-KILDER (brug kun til research, ikke copy):\n${args.competitorUrls.map((url) => `- ${url}`).join('\n')}`
    : '\nKONKURRENT-KILDER: Ingen angivet, brug bred web-research i samme kategori.';

  return `Du er research-analytiker for e-commerce content (due diligence).

Opgave:
1) Undersøg produktet via web og de angivne konkurrentkilder.
2) Identificér de stærkeste faktuelle punkter der bør fremhæves i det specifikke felt.
3) Returnér KUN en kort research-rapport i punktform — ingen prosa, ingen forklaringer.

VIGTIGE REGLER:
- Ingen copy-paste eller direkte gengivelse fra konkurrenter.
- Ingen direkte formuleringer, slogans eller unikke claims fra konkurrenter.
- Marker usikre eller ubekræftede oplysninger med "(kræver validering)".
- Fokusér på: købsdrivere, typiske kundespørgsmål, differentiatorer, tekniske specifikationer der efterspørges, compliance/sikkerhed, brugssituationer.
- Ignorér generiske salgspunkter som "høj kvalitet" og "brugervenlig" — find konkrete, faktuelle detaljer.

Produktkontekst:
- Titel: ${args.variables.title}
- Leverandør: ${args.variables.vendor || '—'}
- Produkttype: ${args.variables.productType || '—'}
- Kategorier: ${args.variables.collections || '—'}
- Handle: ${args.variables.handle}
- Beskrivelse (rå): ${args.variables.descriptionHtml || '(ingen beskrivelse)'}

Felt der skal skrives til:
${args.renderedPrompt}
${competitorBlock}

Outputformat (stramt):
- 6-12 bullets, hver starter med "- "
- Dansk
- Ingen HTML, ingen markdown, ingen code fences.`;
};

const callOpenAi = async (
  apiKey: string,
  prompt: string,
  options?: { webSearchEnabled?: boolean },
): Promise<{ text: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number } }> => {
  const executeRequest = async (withWebSearch: boolean): Promise<Response> => {
    const body: Record<string, unknown> = {
      model: env.OPENAI_MODEL,
      input: prompt,
      temperature: 0.7,
    };

    if (withWebSearch) {
      body.tools = [{ type: 'web_search_preview' }];
    }

    return fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  };

  let response = await executeRequest(Boolean(options?.webSearchEnabled));

  if (!response.ok && options?.webSearchEnabled) {
    const firstError = await response.text();
    logger.warn({ firstError }, 'OpenAI web search call failed, retrying without web search tool');
    response = await executeRequest(false);
    if (!response.ok) {
      const secondError = await response.text();
      throw new Error(`OpenAI request failed: ${response.status} ${secondError}`);
    }
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${text}`);
  }

  const json = (await response.json()) as {
    output_text?: string;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  };

  const usage = {
    promptTokens: Number(json.usage?.input_tokens ?? 0),
    completionTokens: Number(json.usage?.output_tokens ?? 0),
    totalTokens: Number(json.usage?.total_tokens ?? Number(json.usage?.input_tokens ?? 0) + Number(json.usage?.output_tokens ?? 0)),
  };

  if (json.output_text && json.output_text.trim().length > 0) {
    return { text: json.output_text.trim(), usage };
  }

  const textFromOutput =
    json.output
      ?.flatMap((item) => item.content ?? [])
      .find((content) => content.type === 'output_text' && content.text)
      ?.text ?? '';

  if (!textFromOutput.trim()) {
    throw new Error('OpenAI response had no text output');
  }

  return { text: textFromOutput.trim(), usage };
};

const sendBulkDoneEmail = async (to: string, subject: string, html: string): Promise<void> => {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to, subject, html }),
    });
  } catch { /* silent */ }
};

const callOpenAiVision = async (
  apiKey: string,
  imageUrl: string,
  prompt: string,
): Promise<string> => {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageUrl, detail: 'low' } },
        ],
      }],
    }),
  });
  if (!response.ok) throw new Error(`Vision API failed: ${response.status}`);
  const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return (json.choices?.[0]?.message?.content ?? '').trim();
};

const markJobRunning = async (syncJobId: string): Promise<void> => {
  await prisma.syncJob.update({ where: { id: syncJobId }, data: { status: 'running', runAt: new Date() } });
};

const markJobDone = async (syncJobId: string): Promise<void> => {
  await prisma.syncJob.update({
    where: { id: syncJobId },
    data: { status: 'done', finishedAt: new Date(), error: null },
  });
};

const markJobFailed = async (syncJobId: string, error: unknown): Promise<void> => {
  const message = error instanceof Error ? error.message : String(error);
  await prisma.syncJob.update({
    where: { id: syncJobId },
    data: { status: 'failed', finishedAt: new Date(), error: message, retries: { increment: 1 } },
  });
};

const syncWorker = new Worker(
  'sync-jobs',
  async (job: Job<SyncJobRef>) => {
    const { syncJobId } = job.data;
    await markJobRunning(syncJobId);

    const syncJob = await prisma.syncJob.findUnique({ where: { id: syncJobId } });
    if (!syncJob) {
      throw new Error('SyncJob not found');
    }

    try {
      if (syncJob.type.startsWith('outbound_')) {
        const shop = await prisma.shop.findUnique({ where: { id: syncJob.shopId } });
        if (!shop) {
          throw new Error('Shop not found');
        }
        const token = decryptSecret(shop.encryptedAdminToken, env.MASTER_ENCRYPTION_KEY);
        const client = new ShopifyGraphQLClient({ storeUrl: shop.shopUrl, adminToken: token });

        if (syncJob.type === 'outbound_product_patch') {
          const payload = syncJob.payloadJson as { productId: string; patch: Record<string, unknown>; syncRunId?: string | null };
          const product = await prisma.product.findFirst({
            where: { id: payload.productId, shopId: syncJob.shopId },
            include: {
              fieldValues: {
                include: {
                  fieldDefinition: true,
                },
              },
            },
          });

          // Record SyncRunChange entries for this product
          if (payload.syncRunId && product) {
            const coreFields = ['title', 'handle', 'vendor', 'productType', 'descriptionHtml'] as const;
            const changes: Array<{ syncRunId: string; entityType: string; entityId: string; fieldKey: string; beforeValue: string | null; afterValue: string | null }> = [];
            for (const field of coreFields) {
              const before = (product as any)[field];
              const after = payload.patch[field];
              if (after !== undefined && String(after ?? '') !== String(before ?? '')) {
                changes.push({
                  syncRunId: payload.syncRunId,
                  entityType: 'product',
                  entityId: product.id,
                  fieldKey: field,
                  beforeValue: before != null ? String(before) : null,
                  afterValue: after != null ? String(after) : null,
                });
              }
            }
            // Also check tagsJson
            if (payload.patch.tagsJson !== undefined) {
              const beforeTags = JSON.stringify(product.tagsJson);
              const afterTags = JSON.stringify(payload.patch.tagsJson);
              if (beforeTags !== afterTags) {
                changes.push({
                  syncRunId: payload.syncRunId,
                  entityType: 'product',
                  entityId: product.id,
                  fieldKey: 'tagsJson',
                  beforeValue: beforeTags,
                  afterValue: afterTags,
                });
              }
            }
            if (changes.length > 0) {
              await prisma.syncRunChange.createMany({ data: changes });
            }
          }

          if (!product?.shopifyProductGid) {
            logger.info({ productId: payload.productId }, 'product has no shopify gid, skipping outbound');
          } else {
            // 1. Core product fields (only if patch explicitly included them)
            const hasCoreFields = payload.patch && Object.keys(payload.patch).some(
              (k) => ['title', 'handle', 'vendor', 'productType', 'tagsJson', 'descriptionHtml', 'seoJson'].includes(k),
            );
            if (hasCoreFields) {
              const seoJson = payload.patch.seoJson as { title?: string; description?: string } | undefined;
              type ProductUpdateResult = { productUpdate: { userErrors: Array<{ field: string[]; message: string }>; product: { id: string } | null } };
              const productUpdateResult = await client.execute<ProductUpdateResult>(
                `mutation ProductUpdate($input: ProductInput!) { productUpdate(input: $input) { userErrors { field message } product { id } } }`,
                {
                  input: {
                    id: product.shopifyProductGid,
                    title: payload.patch.title,
                    handle: payload.patch.handle,
                    vendor: payload.patch.vendor,
                    productType: payload.patch.productType,
                    tags: payload.patch.tagsJson,
                    descriptionHtml: payload.patch.descriptionHtml,
                    ...(seoJson ? { seo: { title: seoJson.title, description: seoJson.description } } : {}),
                  },
                },
              );
              const productUpdateErrors = productUpdateResult.productUpdate?.userErrors ?? [];
              if (productUpdateErrors.length > 0) {
                throw new Error(`Shopify productUpdate failed: ${productUpdateErrors.map((e) => e.message).join(', ')}`);
              }
            }

            // 2. Metafields via mappings
            if (product.fieldValues.length > 0) {
              // Fetch mappings for all field definitions on this product
              const fieldDefinitionIds = product.fieldValues.map((fv) => fv.fieldDefinitionId);
              const mappings = await prisma.mapping.findMany({
                where: {
                  fieldDefinitionId: { in: fieldDefinitionIds },
                  direction: { in: ['PIM_TO_SHOPIFY', 'TWO_WAY'] },
                },
              });

              type MetafieldSetInput = { ownerId: string; namespace: string; key: string; type: string; value: string };
              type MetafieldRef = { namespace: string; key: string };
              const metafieldToSet: MetafieldSetInput[] = [];
              const metafieldToClear: MetafieldRef[] = [];

              for (const fv of product.fieldValues) {
                const mapping = mappings.find((m) => m.fieldDefinitionId === fv.fieldDefinitionId);
                if (!mapping || mapping.targetType !== 'metafield') continue;

                const target = mapping.targetJson as { namespace: string; key: string; valueType?: string };
                if (!target.namespace || !target.key) continue;

                // Convert valueJson to Shopify metafield string value
                let value: string;
                if (typeof fv.valueJson === 'string') {
                  value = fv.valueJson;
                } else if (fv.valueJson == null) {
                  continue; // skip null values — no change in Shopify
                } else {
                  value = JSON.stringify(fv.valueJson);
                }

                // Empty string → delete the metafield in Shopify (metafieldsSet rejects blank values)
                if (value.trim() === '') {
                  metafieldToClear.push({ namespace: target.namespace, key: target.key });
                  continue;
                }

                // Resolve Shopify metafield type — fallback to single_line_text_field
                const sfType = (target.valueType ?? 'single_line_text_field').trim();

                // For JSON-based metafield types, the value must be valid JSON of the correct shape.
                let finalValue = value;
                if (sfType === 'rich_text_field') {
                  // If value is already valid rich text JSON, use as-is.
                  // Otherwise pass through as-is (user should use multi_line_text_field for HTML).
                  let parsed: unknown;
                  try { parsed = JSON.parse(value); } catch { parsed = undefined; }
                  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                    // already valid rich text JSON — fine
                  } else {
                    finalValue = value; // pass HTML/text directly
                  }
                } else if (sfType.startsWith('list.')) {
                  // list.* types require a JSON array.
                  let parsed: unknown;
                  try { parsed = JSON.parse(value); } catch { parsed = undefined; }
                  if (!Array.isArray(parsed)) {
                    try { finalValue = JSON.stringify([value]); } catch { continue; }
                  }
                } else if (sfType === 'json') {
                  // json type accepts any valid JSON; wrap plain strings.
                  try { JSON.parse(value); } catch { finalValue = JSON.stringify(value); }
                }

                metafieldToSet.push({ ownerId: product.shopifyProductGid, namespace: target.namespace, key: target.key, type: sfType, value: finalValue });
              }

              if (metafieldToSet.length > 0) {
                type MetafieldsSetResult = { metafieldsSet: { userErrors: Array<{ field: string[]; message: string }> } };
                const result = await client.execute<MetafieldsSetResult>(
                  `mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
                    metafieldsSet(metafields: $metafields) {
                      metafields { key namespace value type }
                      userErrors { field message }
                    }
                  }`,
                  { metafields: metafieldToSet },
                );
                const errors = result.metafieldsSet?.userErrors ?? [];
                if (errors.length > 0) {
                  throw new Error(`Shopify metafieldsSet failed: ${errors.map((e) => e.message).join(', ')}`);
                } else {
                  logger.info({ count: metafieldToSet.length, productId: product.id }, 'metafieldsSet ok');
                }
              }

              if (metafieldToClear.length > 0) {
                // Query existing metafield IDs using aliases (identifiers arg removed in API 2025-01)
                const aliases = metafieldToClear.map((m: { namespace: string; key: string }, i: number) =>
                  `mf${i}: metafield(namespace: ${JSON.stringify(m.namespace)}, key: ${JSON.stringify(m.key)}) { id }`,
                ).join(' ');
                type MetafieldAliasResult = { product: Record<string, { id: string } | null> };
                const queryResult = await client.execute<MetafieldAliasResult>(
                  `query GetMetafieldIds($id: ID!) { product(id: $id) { ${aliases} } }`,
                  { id: product.shopifyProductGid },
                );
                const existingIds = Object.values(queryResult.product ?? {}).filter(Boolean).map((m) => (m as { id: string }).id);
                for (const mfId of existingIds) {
                  type DeleteResult = { metafieldDelete: { userErrors: Array<{ field: string[]; message: string }> } };
                  const delResult = await client.execute<DeleteResult>(
                    `mutation MetafieldDelete($input: MetafieldDeleteInput!) {
                      metafieldDelete(input: $input) { userErrors { field message } }
                    }`,
                    { input: { id: mfId } },
                  );
                  const delErrors = delResult.metafieldDelete?.userErrors ?? [];
                  if (delErrors.length > 0) {
                    logger.warn({ mfId, errors: delErrors }, 'metafieldDelete had userErrors');
                  }
                }
                logger.info({ count: existingIds.length, productId: product.id }, 'metafield delete ok for empty values');
              }
            }
          }
          if (product) {
            await prisma.product.update({ where: { id: product.id }, data: { lastShopifySyncAt: new Date() } });
          }
        }

        if (syncJob.type === 'outbound_variant_patch') {
          const payload = syncJob.payloadJson as { variantId: string; patch: Record<string, unknown> };
          const variant = await prisma.variant.findFirst({ where: { id: payload.variantId, product: { shopId: syncJob.shopId } } });
          if (!variant?.shopifyVariantGid) {
            logger.info({ variantId: payload.variantId }, 'variant has no shopify gid, skipping outbound');
          } else {
            const variantInput: Record<string, unknown> = {
              id: variant.shopifyVariantGid,
              sku: payload.patch.sku,
              barcode: payload.patch.barcode,
              price: payload.patch.price,
              compareAtPrice: payload.patch.compareAtPrice,
            };
            if (payload.patch.weight != null) variantInput.weight = payload.patch.weight;
            if (payload.patch.weightUnit != null) variantInput.weightUnit = payload.patch.weightUnit;
            if (payload.patch.requiresShipping != null) variantInput.requiresShipping = payload.patch.requiresShipping;
            if (payload.patch.taxable != null) variantInput.taxable = payload.patch.taxable;
            if (payload.patch.inventoryPolicy != null) variantInput.inventoryPolicy = payload.patch.inventoryPolicy;
            type VariantUpdateResult = { productVariantUpdate: { userErrors: Array<{ field: string[]; message: string }>; productVariant: { id: string } | null } };
            const variantUpdateResult = await client.execute<VariantUpdateResult>(
              `mutation ProductVariantUpdate($input: ProductVariantInput!) { productVariantUpdate(input: $input) { userErrors { field message } productVariant { id } } }`,
              { input: variantInput },
            );
            const variantUpdateErrors = variantUpdateResult.productVariantUpdate?.userErrors ?? [];
            if (variantUpdateErrors.length > 0) {
              throw new Error(`Shopify productVariantUpdate failed: ${variantUpdateErrors.map((e) => e.message).join(', ')}`);
            }
          }
          if (variant) {
            await prisma.variant.update({ where: { id: variant.id }, data: { lastShopifySyncAt: new Date() } });
          }
        }

        if (syncJob.type === 'outbound_collection_patch') {
          const payload = syncJob.payloadJson as { collectionId: string; patch: Record<string, unknown> };
          const collection = await prisma.collection.findFirst({
            where: { id: payload.collectionId, shopId: syncJob.shopId },
          });

          if (!collection?.shopifyCollectionGid) {
            logger.info({ collectionId: payload.collectionId }, 'collection has no shopify gid, skipping outbound');
          } else {
            type CollectionUpdateResult = { collectionUpdate: { userErrors: Array<{ field: string[]; message: string }>; collection: { id: string } | null } };
            const collectionUpdateResult = await client.execute<CollectionUpdateResult>(
              `mutation CollectionUpdate($input: CollectionInput!) { collectionUpdate(input: $input) { userErrors { field message } collection { id } } }`,
              {
                input: {
                  id: collection.shopifyCollectionGid,
                  title: payload.patch.title,
                  handle: payload.patch.handle,
                  descriptionHtml: payload.patch.descriptionHtml,
                },
              },
            );
            const collectionUpdateErrors = collectionUpdateResult.collectionUpdate?.userErrors ?? [];
            if (collectionUpdateErrors.length > 0) {
              throw new Error(`Shopify collectionUpdate failed: ${collectionUpdateErrors.map((e) => e.message).join(', ')}`);
            }

            await prisma.collection.update({
              where: { id: collection.id },
              data: { lastShopifySyncAt: new Date() },
            });
          }
        }
      }

      if (syncJob.type === 'inbound_delta_sync') {
        const payload = syncJob.payloadJson as { since: string };
        const shop = await prisma.shop.findUnique({ where: { id: syncJob.shopId } });
        if (!shop?.encryptedAdminToken) {
          logger.warn({ shopId: syncJob.shopId }, 'delta sync: shop missing token, skipping');
        } else {
          const token = decryptSecret(shop.encryptedAdminToken, env.MASTER_ENCRYPTION_KEY);
          const client = new ShopifyGraphQLClient({ storeUrl: shop.shopUrl, adminToken: token });
          const since = payload.since;
          const queryFilter = `updated_at:>'${since}'`;

          type DeltaVariantNode = {
            id: string; sku?: string | null; barcode?: string | null; price?: string | null;
            compareAtPrice?: string | null; taxable?: boolean | null; inventoryPolicy?: string | null;
            inventoryItem?: { requiresShipping?: boolean | null; measurement?: { weight?: { value?: number | null; unit?: string | null } | null } | null } | null;
            selectedOptions?: Array<{ value: string }>;
          };
          type DeltaProductNode = {
            id: string; title: string; handle: string; vendor?: string | null; productType?: string | null;
            status?: string | null; descriptionHtml?: string | null; tags: string[];
            variants: { edges: Array<{ node: DeltaVariantNode }> };
          };
          type DeltaSyncResponse = {
            products: { edges: Array<{ node: DeltaProductNode }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
          };

          let hasMore = true;
          let cursor: string | null = null;
          let productsProcessed = 0;

          while (hasMore) {
            // eslint-disable-next-line no-await-in-loop
            const result: DeltaSyncResponse = await client.execute(
              `query DeltaSync($filter: String!, $after: String) {
                products(first: 50, after: $after, query: $filter) {
                  edges { node {
                    id title handle vendor productType status publishedAt descriptionHtml tags
                    variants(first: 100) { edges { node {
                      id sku barcode price compareAtPrice taxable inventoryPolicy
                      inventoryItem { requiresShipping measurement { weight { value unit } } }
                      selectedOptions { value }
                    } } }
                  } }
                  pageInfo { hasNextPage endCursor }
                }
              }`,
              { filter: queryFilter, after: cursor },
            );

            const now = new Date();
            for (const edge of result.products.edges) {
              const node = edge.node;
              const inboundFields = {
                title: node.title,
                handle: node.handle,
                vendor: node.vendor ?? undefined,
                productType: node.productType ?? undefined,
                status: node.status ?? undefined,
                descriptionHtml: node.descriptionHtml ?? undefined,
                tagsJson: node.tags ?? [],
                publishedAt: (node as any).publishedAt ? new Date((node as any).publishedAt) : null,
              };

              const existing = await prisma.product.findFirst({
                where: { shopId: syncJob.shopId, shopifyProductGid: node.id },
              });

              if (existing) {
                const hasLocalChanges =
                  existing.lastShopifySyncAt != null &&
                  existing.updatedAt.getTime() > existing.lastShopifySyncAt.getTime() + 1000;

                if (hasLocalChanges) {
                  await prisma.$executeRaw`UPDATE "Product" SET "shopifyUpdatedAt" = ${now} WHERE id = ${existing.id}`;
                  logger.info({ productId: existing.id }, 'delta sync: conflict hold, skipping update');
                } else {
                  await prisma.product.update({
                    where: { id: existing.id },
                    data: { ...inboundFields, shopifyUpdatedAt: now, lastShopifySyncAt: now },
                  });

                  // Upsert variants from delta payload
                  for (const ve of node.variants.edges) {
                    const vn = ve.node;
                    const existingVariant = await prisma.variant.findFirst({
                      where: { shopifyVariantGid: vn.id, productId: existing.id },
                    });
                    const variantData = {
                      sku: vn.sku ?? undefined,
                      barcode: vn.barcode ?? undefined,
                      price: vn.price ?? undefined,
                      compareAtPrice: vn.compareAtPrice ?? undefined,
                      optionValuesJson: (vn.selectedOptions ?? []).map((o: { value: string }) => o.value),
                      weight: vn.inventoryItem?.measurement?.weight?.value ?? undefined,
                      weightUnit: vn.inventoryItem?.measurement?.weight?.unit ?? undefined,
                      requiresShipping: vn.inventoryItem?.requiresShipping ?? undefined,
                      taxable: vn.taxable ?? undefined,
                      inventoryPolicy: vn.inventoryPolicy ?? undefined,
                      lastShopifySyncAt: now,
                    };
                    if (existingVariant) {
                      const variantLocallyChanged =
                        existingVariant.lastShopifySyncAt != null &&
                        existingVariant.updatedAt.getTime() > existingVariant.lastShopifySyncAt.getTime() + 1000;
                      if (!variantLocallyChanged) {
                        await prisma.variant.update({ where: { id: existingVariant.id }, data: variantData });
                      }
                    } else {
                      await prisma.variant.create({ data: { ...variantData, productId: existing.id, shopifyVariantGid: vn.id } });
                    }
                  }

                  logger.info({ productId: existing.id }, 'delta sync: applied inbound changes');
                }
              }
              // New products from Shopify are only created on explicit pull — skip here to keep delta sync lightweight
              productsProcessed++;
            }

            hasMore = result.products.pageInfo.hasNextPage;
            cursor = result.products.pageInfo.endCursor;
          }

          logger.info({ shopId: syncJob.shopId, since, productsProcessed }, 'delta sync: completed');
        }
      }

      await markJobDone(syncJobId);

      // Check if this completes a SyncRun
      const syncRunId = (syncJob.payloadJson as any)?.syncRunId as string | undefined;
      if (syncRunId) {
        const pendingJobs = await prisma.syncJob.count({
          where: {
            shopId: syncJob.shopId,
            status: { in: ['queued', 'running'] },
            payloadJson: { path: ['syncRunId'], equals: syncRunId },
          },
        });
        if (pendingJobs === 0) {
          await prisma.syncRun.update({
            where: { id: syncRunId },
            data: { status: 'done', finishedAt: new Date() },
          });
        }
      }
    } catch (error) {
      await markJobFailed(syncJobId, error);

      // Mark SyncRun as failed if any job fails
      const failedSyncRunId = (syncJob.payloadJson as any)?.syncRunId as string | undefined;
      if (failedSyncRunId) {
        await prisma.syncRun.update({
          where: { id: failedSyncRunId },
          data: { status: 'failed', finishedAt: new Date() },
        }).catch(() => { /* ignore if already updated */ });
      }

      throw error;
    }
  },
  { connection },
);

const webhookWorker = new Worker(
  'webhook-jobs',
  async (job: Job<SyncJobRef>) => {
    const { syncJobId } = job.data;
    await markJobRunning(syncJobId);
    const syncJob = await prisma.syncJob.findUnique({ where: { id: syncJobId } });
    if (!syncJob) {
      throw new Error('SyncJob not found');
    }

    try {
      const payload = syncJob.payloadJson as Record<string, unknown>;
      const productGid = payload.admin_graphql_api_id as string | undefined;
      const topic = syncJob.type; // e.g. 'webhook_products/update'

      // app/uninstalled — mark shop as disconnected
      if (topic === 'webhook_app/uninstalled') {
        await prisma.shop.update({
          where: { id: syncJob.shopId },
          data: { status: 'disconnected' },
        });
        logger.info({ shopId: syncJob.shopId }, 'app/uninstalled: shop marked disconnected');
        await markJobDone(syncJobId);
        return;
      }

      // collections/create or collections/update
      if (topic === 'webhook_collections/create' || topic === 'webhook_collections/update') {
        const collectionGid = payload.admin_graphql_api_id as string | undefined;
        if (collectionGid) {
          const title = (payload.title as string | undefined) ?? 'Untitled';
          const handle = (payload.handle as string | undefined) ?? `shopify-${Date.now()}`;
          const descriptionHtml = (payload.body_html as string | undefined) ?? null;
          const now = new Date();
          const collection = await prisma.collection.upsert({
            where: { shopifyCollectionGid: collectionGid },
            create: {
              shopId: syncJob.shopId,
              shopifyCollectionGid: collectionGid,
              title,
              handle,
              descriptionHtml,
              lastShopifySyncAt: now,
              shopifyUpdatedAt: now,
            },
            update: {
              title,
              handle,
              descriptionHtml,
              shopifyUpdatedAt: now,
              lastShopifySyncAt: now,
            },
          });
          await prisma.changeLog.create({
            data: {
              shopId: syncJob.shopId,
              entityType: 'collection',
              entityId: collection.id,
              source: 'shopify_webhook',
              afterJson: payload as any,
              jobId: syncJob.id,
            },
          });
          logger.info({ collectionId: collection.id, topic }, 'webhook collection upserted');
        }
        await markJobDone(syncJobId);
        return;
      }

      // collections/delete — remove collection from EL-PIM
      if (topic === 'webhook_collections/delete') {
        const collectionGid = payload.admin_graphql_api_id as string | undefined;
        if (collectionGid) {
          const existing = await prisma.collection.findFirst({
            where: { shopId: syncJob.shopId, shopifyCollectionGid: collectionGid },
          });
          if (existing) {
            await prisma.collection.delete({ where: { id: existing.id } });
            logger.info({ collectionId: existing.id }, 'webhook collections/delete: collection removed');
          }
        }
        await markJobDone(syncJobId);
        return;
      }

      // products/delete — soft-delete the product (set shopifyDeletedAt)
      if (topic === 'webhook_products/delete') {
        if (productGid) {
          const existing = await prisma.product.findFirst({
            where: { shopId: syncJob.shopId, shopifyProductGid: productGid },
          });
          if (existing) {
            const deletedAt = new Date();
            await prisma.product.update({
              where: { id: existing.id },
              data: { shopifyDeletedAt: deletedAt },
            });
            await prisma.changeLog.create({
              data: {
                shopId: syncJob.shopId,
                entityType: 'product',
                entityId: existing.id,
                source: 'shopify_webhook',
                afterJson: { deleted: true, shopifyDeletedAt: deletedAt.toISOString(), shopifyProductGid: productGid } as any,
                jobId: syncJob.id,
              },
            });
            logger.info({ productId: existing.id }, 'webhook products/delete: soft-deleted (shopifyDeletedAt set)');
          }
        }
        await markJobDone(syncJobId);
        return;
      }

      // products/create or products/update
      if (productGid) {
        const title = (payload.title as string | undefined) ?? 'Untitled';
        const handle = (payload.handle as string | undefined) ?? `shopify-${Date.now()}`;
        const vendor = (payload.vendor as string | undefined) ?? undefined;
        const productType = (payload.product_type as string | undefined) ?? undefined;
        const status = (payload.status as string | undefined) ?? undefined;
        const descriptionHtml = (payload.body_html as string | undefined) ?? undefined;
        const rawTags = payload.tags;
        const tagsJson: string[] = Array.isArray(rawTags)
          ? (rawTags as string[])
          : typeof rawTags === 'string' && rawTags
            ? rawTags.split(',').map((t) => t.trim()).filter(Boolean)
            : [];

        const now = new Date();
        const rawPublishedAt = payload.published_at;
        const publishedAt = typeof rawPublishedAt === 'string' && rawPublishedAt ? new Date(rawPublishedAt) : null;
        const rawImages = payload.images;
        const imagesJson = Array.isArray(rawImages)
          ? (rawImages as Array<{ src?: string; alt?: string | null }>)
              .filter((img) => img.src)
              .map((img) => ({ url: img.src!, altText: img.alt ?? null }))
          : undefined;
        const inboundFields = {
          title, handle, vendor, productType, status, descriptionHtml, tagsJson, publishedAt,
          ...(imagesJson !== undefined ? { imagesJson } : {}),
        };

        const existing = await prisma.product.findFirst({
          where: { shopId: syncJob.shopId, shopifyProductGid: productGid },
        });

        if (existing) {
          // Conflict detection: EL-PIM has local changes that haven't been pushed out yet
          const hasLocalChanges =
            existing.lastShopifySyncAt != null &&
            existing.updatedAt.getTime() > existing.lastShopifySyncAt.getTime() + 1000;

          if (hasLocalChanges) {
            // Conflict hold — record Shopify's intent but don't overwrite EL-PIM data.
            // Use raw SQL to avoid bumping @updatedAt (which would cause perpetual conflict holds).
            await prisma.$executeRaw`UPDATE "Product" SET "shopifyUpdatedAt" = ${now} WHERE id = ${existing.id}`;
            await prisma.changeLog.create({
              data: {
                shopId: syncJob.shopId,
                entityType: 'product',
                entityId: existing.id,
                source: 'conflict_hold',
                beforeJson: { title: existing.title, handle: existing.handle } as any,
                afterJson: { ...inboundFields, reason: 'shopify_webhook_conflict' } as any,
                jobId: syncJob.id,
              },
            });
            logger.warn(
              { productId: existing.id, existingUpdatedAt: existing.updatedAt, lastSyncAt: existing.lastShopifySyncAt },
              'webhook conflict hold: EL-PIM has local changes, not applying Shopify inbound',
            );
          } else {
            // Clean apply — no local pending changes, safe to accept Shopify data
            await prisma.product.update({
              where: { id: existing.id },
              data: {
                ...inboundFields,
                shopifyUpdatedAt: now,
                lastShopifySyncAt: now,
              },
            });
            await prisma.changeLog.create({
              data: {
                shopId: syncJob.shopId,
                entityType: 'product',
                entityId: existing.id,
                source: 'shopify_webhook',
                beforeJson: { title: existing.title, handle: existing.handle } as any,
                afterJson: payload as any,
                jobId: syncJob.id,
              },
            });
            logger.info({ productId: existing.id }, 'webhook products/update applied cleanly');
          }
        } else {
          // New product from Shopify
          const created = await prisma.product.create({
            data: {
              shopId: syncJob.shopId,
              shopifyProductGid: productGid,
              ...inboundFields,
              seoJson: {},
              createdVia: 'shopify',
              shopifyUpdatedAt: now,
              lastShopifySyncAt: now,
            },
          });
          await prisma.changeLog.create({
            data: {
              shopId: syncJob.shopId,
              entityType: 'product',
              entityId: created.id,
              source: 'shopify_webhook',
              afterJson: payload as any,
              jobId: syncJob.id,
            },
          });
          logger.info({ productId: created.id }, 'webhook products/create: new product created');
        }

        // Process variants from webhook payload
        const payloadVariants = payload.variants;
        if (Array.isArray(payloadVariants) && payloadVariants.length > 0) {
          const product = existing ?? await prisma.product.findFirst({ where: { shopId: syncJob.shopId, shopifyProductGid: productGid } });
          if (product) {
            for (const v of payloadVariants as Record<string, unknown>[]) {
              const variantGid = typeof v.admin_graphql_api_id === 'string' ? v.admin_graphql_api_id : null;
              if (!variantGid) continue;

              const existingVariant = await prisma.variant.findFirst({
                where: { shopifyVariantGid: variantGid, productId: product.id },
              });

              const optionValues: string[] = [];
              if (v.option1 && typeof v.option1 === 'string') optionValues.push(v.option1);
              if (v.option2 && typeof v.option2 === 'string') optionValues.push(v.option2);
              if (v.option3 && typeof v.option3 === 'string') optionValues.push(v.option3);

              const variantData = {
                sku: typeof v.sku === 'string' ? v.sku : undefined,
                barcode: typeof v.barcode === 'string' ? v.barcode : undefined,
                price: typeof v.price === 'string' ? v.price : undefined,
                compareAtPrice: typeof v.compare_at_price === 'string' ? v.compare_at_price : undefined,
                optionValuesJson: optionValues,
                weight: typeof v.grams === 'number' ? v.grams / 1000 : undefined, // Shopify REST sends grams
                weightUnit: typeof v.weight_unit === 'string' ? (v.weight_unit as string).toUpperCase() : undefined,
                requiresShipping: typeof v.requires_shipping === 'boolean' ? v.requires_shipping : undefined,
                taxable: typeof v.taxable === 'boolean' ? v.taxable : undefined,
                inventoryPolicy: typeof v.inventory_policy === 'string' ? (v.inventory_policy as string).toUpperCase() : undefined,
                inventoryQuantity: typeof v.inventory_quantity === 'number' ? v.inventory_quantity : undefined,
                lastShopifySyncAt: now,
              };

              if (existingVariant) {
                const variantLocallyChanged =
                  existingVariant.lastShopifySyncAt != null &&
                  existingVariant.updatedAt.getTime() > existingVariant.lastShopifySyncAt.getTime() + 1000;

                if (!variantLocallyChanged) {
                  await prisma.variant.update({ where: { id: existingVariant.id }, data: variantData });
                } else {
                  await prisma.$executeRaw`UPDATE "Variant" SET "shopifyUpdatedAt" = ${now} WHERE id = ${existingVariant.id}`;
                }
              } else {
                await prisma.variant.create({
                  data: { ...variantData, productId: product.id, shopifyVariantGid: variantGid },
                });
              }
            }
          }
        }
      }

      await markJobDone(syncJobId);
    } catch (error) {
      await markJobFailed(syncJobId, error);
      throw error;
    }
  },
  { connection },
);

const detectCsvSep = (csv: string): string => {
  const firstLine = csv.split('\n')[0] ?? '';
  return (firstLine.match(/;/g) ?? []).length > (firstLine.match(/,/g) ?? []).length ? ';' : ',';
};

const parseCsvRow = (line: string, sep: string): string[] => {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === sep && !inQuotes) { result.push(current.trim()); current = ''; }
    else { current += ch; }
  }
  result.push(current.trim());
  return result;
};

const normalizeImportStatus = (s: string): string => {
  const u = s.toUpperCase().trim();
  if (['ACTIVE', 'AKTIV', '1', 'TRUE', 'JA'].includes(u)) return 'ACTIVE';
  if (['ARCHIVED', 'ARKIVERET'].includes(u)) return 'ARCHIVED';
  return 'DRAFT';
};

const importWorker = new Worker(
  'import-jobs',
  async (job: Job<SyncJobRef>) => {
    const { syncJobId } = job.data;
    await markJobRunning(syncJobId);
    const syncJob = await prisma.syncJob.findUnique({ where: { id: syncJobId } });
    if (!syncJob) throw new Error('SyncJob not found');

    try {
      if (syncJob.type === 'import_csv_v2') {
        await handleImportCsvV2(syncJob);
      } else {
        // legacy import_csv: simple title+handle update
        const payload = syncJob.payloadJson as { csv: string };
        const lines = payload.csv.split('\n').filter(Boolean);
        const [, ...dataLines] = lines;
        for (const line of dataLines) {
          const [productId, title, handle] = line.split(',');
          if (!productId) continue;
          const existing = await prisma.product.findFirst({ where: { id: productId, shopId: syncJob.shopId } });
          if (!existing) continue;
          await prisma.snapshot.create({
            data: { shopId: existing.shopId, entityType: 'product', entityId: existing.id, blobJson: existing, reason: 'import_apply' },
          });
          await prisma.product.update({ where: { id: existing.id }, data: { title: title ?? existing.title, handle: handle ?? existing.handle } });
        }
        await markJobDone(syncJobId);
      }
    } catch (error) {
      await markJobFailed(syncJobId, error);
      throw error;
    }
  },
  { connection },
);

async function handleImportCsvV2(syncJob: { id: string; shopId: string; payloadJson: unknown }): Promise<void> {
  const payload = syncJob.payloadJson as { csv: string; columnMap: Record<string, string>; conflictPolicy?: string };
  const { csv, columnMap } = payload;
  const conflictPolicy = (payload.conflictPolicy ?? 'update') as 'update' | 'skip' | 'create_new';

  const shop = await prisma.shop.findUnique({ where: { id: syncJob.shopId } });
  if (!shop) throw new Error('Shop not found');

  const token = decryptSecret(shop.encryptedAdminToken, env.MASTER_ENCRYPTION_KEY);
  const client = new ShopifyGraphQLClient({ storeUrl: shop.shopUrl, adminToken: token });

  const sep = detectCsvSep(csv);
  const lines = csv.split('\n').filter(Boolean);
  const headers = parseCsvRow(lines[0] ?? '', sep);
  const dataLines = lines.slice(1);

  let created = 0;
  let updated = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const line of dataLines) {
    const rowValues = parseCsvRow(line, sep);
    const rawRow: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) rawRow[headers[i] ?? ''] = rowValues[i] ?? '';

    // Apply column mapping to get Shopify fields
    const mapped: Record<string, string> = {};
    for (const [csvCol, shopifyField] of Object.entries(columnMap)) {
      if (shopifyField !== 'ignore' && rawRow[csvCol] !== undefined) {
        mapped[shopifyField] = rawRow[csvCol] ?? '';
      }
    }

    const title = mapped.title?.trim();
    if (!title) {
      errors.push(`Skipped row (no title): ${line.slice(0, 60)}`);
      failed++;
      continue;
    }

    try {
      const shopifyGid = mapped.shopifyId?.trim() || null;
      const handle = mapped.handle?.trim() || null;
      const descriptionHtml = mapped.descriptionHtml?.trim() || null;
      const vendor = mapped.vendor?.trim() || null;
      const productType = mapped.productType?.trim() || null;
      const status = mapped.status ? normalizeImportStatus(mapped.status) : 'DRAFT';
      const tagsRaw = mapped.tags?.trim() || '';
      const tagsArray = tagsRaw ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean) : [];

      // Find existing product in EL-PIM — by GID, handle, or SKU (variant)
      let existingProduct: { id: string; shopifyProductGid: string | null } | null = null;
      if (shopifyGid) {
        existingProduct = await prisma.product.findFirst({
          where: { shopifyProductGid: shopifyGid, shopId: syncJob.shopId },
          select: { id: true, shopifyProductGid: true },
        });
      }
      if (!existingProduct && handle) {
        existingProduct = await prisma.product.findFirst({
          where: { handle, shopId: syncJob.shopId },
          select: { id: true, shopifyProductGid: true },
        });
      }
      const sku = mapped.sku?.trim() || null;
      if (!existingProduct && sku) {
        const variantMatch = await prisma.variant.findFirst({
          where: { sku, product: { shopId: syncJob.shopId } },
          select: { product: { select: { id: true, shopifyProductGid: true } } },
        });
        if (variantMatch?.product) existingProduct = variantMatch.product;
      }

      // Apply conflict policy when an existing product is found
      if (existingProduct && conflictPolicy === 'skip') {
        continue;
      }
      if (existingProduct && conflictPolicy === 'create_new') {
        existingProduct = null; // treat as new
      }

      if (existingProduct) {
        // Update existing product in EL-PIM
        await prisma.snapshot.create({
          data: { shopId: syncJob.shopId, entityType: 'product', entityId: existingProduct.id, blobJson: existingProduct, reason: 'import_apply' },
        });
        await prisma.product.update({
          where: { id: existingProduct.id },
          data: {
            ...(title ? { title } : {}),
            ...(handle ? { handle } : {}),
            ...(descriptionHtml !== null ? { descriptionHtml } : {}),
            ...(vendor !== null ? { vendor } : {}),
            ...(productType !== null ? { productType } : {}),
            status,
            ...(tagsArray.length ? { tagsJson: tagsArray } : {}),
          },
        });

        // Push to Shopify if we have a GID
        const gidToUse = existingProduct.shopifyProductGid;
        if (gidToUse) {
          type ProductUpdateResult = { productUpdate: { userErrors: Array<{ message: string }>; product: { id: string } | null } };
          const updateInput: Record<string, unknown> = { id: gidToUse, title, status };
          if (handle) updateInput.handle = handle;
          if (descriptionHtml !== null) updateInput.descriptionHtml = descriptionHtml;
          if (vendor !== null) updateInput.vendor = vendor;
          if (productType !== null) updateInput.productType = productType;
          if (tagsArray.length) updateInput.tags = tagsArray;

          const updateResult = await client.execute<ProductUpdateResult>(
            `mutation ProductUpdate($input: ProductInput!) { productUpdate(input: $input) { userErrors { message } product { id } } }`,
            { input: updateInput },
          );
          const errs = updateResult.productUpdate?.userErrors ?? [];
          if (errs.length) throw new Error(`Shopify productUpdate: ${errs.map((e) => e.message).join(', ')}`);
        }
        updated++;
      } else {
        // Create new product in Shopify
        type ProductCreateResult = { productCreate: { userErrors: Array<{ message: string }>; product: { id: string; handle: string } | null } };
        const createInput: Record<string, unknown> = { title, status };
        if (handle) createInput.handle = handle;
        if (descriptionHtml !== null) createInput.descriptionHtml = descriptionHtml;
        if (vendor !== null) createInput.vendor = vendor;
        if (productType !== null) createInput.productType = productType;
        if (tagsArray.length) createInput.tags = tagsArray;

        const createResult = await client.execute<ProductCreateResult>(
          `mutation ProductCreate($input: ProductInput!) { productCreate(input: $input) { userErrors { message } product { id handle } } }`,
          { input: createInput },
        );
        const errs = createResult.productCreate?.userErrors ?? [];
        if (errs.length) throw new Error(`Shopify productCreate: ${errs.map((e) => e.message).join(', ')}`);

        const shopifyProduct = createResult.productCreate?.product;
        if (!shopifyProduct) throw new Error('Shopify productCreate returned no product');

        // Store in EL-PIM
        await prisma.product.create({
          data: {
            shopId: syncJob.shopId,
            title,
            handle: shopifyProduct.handle,
            shopifyProductGid: shopifyProduct.id,
            status,
            vendor: vendor ?? null,
            productType: productType ?? null,
            descriptionHtml: descriptionHtml ?? null,
            tagsJson: tagsArray,
            seoJson: {},
            createdVia: 'import',
          },
        });
        created++;
      }
    } catch (rowErr: unknown) {
      const msg = rowErr instanceof Error ? rowErr.message : String(rowErr);
      errors.push(`Row "${title}": ${msg}`);
      failed++;
    }
  }

  // Store result in payloadJson
  await prisma.syncJob.update({
    where: { id: syncJob.id },
    data: {
      status: 'done',
      finishedAt: new Date(),
      payloadJson: { ...payload, result: { created, updated, failed, errors: errors.slice(0, 20) } } as any,
    },
  });
}

const aiWorker = new Worker(
  'ai-jobs',
  async (job: Job<AiJobRef>) => {
    const { syncJobId, userId } = job.data;
    await markJobRunning(syncJobId);
    const syncJob = await prisma.syncJob.findUnique({ where: { id: syncJobId } });
    if (!syncJob) {
      throw new Error('SyncJob not found');
    }

    try {
      const payload = syncJob.payloadJson as {
        rows: Array<{ ownerType: 'product' | 'variant' | 'collection'; ownerId: string }>;
        fieldDefinitionId: string;
        promptTemplate: string;
        webSearch?: boolean;
        competitorUrls?: string[];
        sourceIds?: string[];
        sourcesOnly?: boolean;
      };

      const fieldDefinition = await prisma.fieldDefinition.findFirst({
        where: { id: payload.fieldDefinitionId, shopId: syncJob.shopId },
      });
      if (!fieldDefinition) {
        throw new Error('Field definition does not belong to sync job shop');
      }
      const outputIsHtml = fieldDefinition?.type === 'html';

      // Fetch shop-level AI settings (master prompt + shop introduction)
      const [aiIntroRow, masterPromptRow] = await Promise.all([
        prisma.shopSetting.findUnique({ where: { shopId_key: { shopId: syncJob.shopId, key: 'ai_introduction' } } }),
        prisma.shopSetting.findUnique({ where: { shopId_key: { shopId: syncJob.shopId, key: 'master_prompt' } } }),
      ]);
      const aiIntroduction = typeof (aiIntroRow?.valueJson as any) === 'string' ? (aiIntroRow?.valueJson as string) : '';
      const masterPrompt = typeof (masterPromptRow?.valueJson as any) === 'string' ? (masterPromptRow?.valueJson as string) : DEFAULT_MASTER_PROMPT;

      // Use platform-wide OpenAI key (not per-user)
      const platformKeyRow = await prisma.platformSetting.findUnique({ where: { key: 'openai_api_key' } });
      const platformKeyData = (platformKeyRow?.valueJson ?? {}) as Record<string, unknown>;
      const encryptedPlatformKey = typeof platformKeyData.encryptedKey === 'string' ? platformKeyData.encryptedKey : null;
      if (!encryptedPlatformKey) {
        throw new Error('Platform OpenAI API key is not configured. Contact platform admin.');
      }
      const openAiApiKey = decryptSecret(encryptedPlatformKey, env.MASTER_ENCRYPTION_KEY);

      let aiProcessed = 0;
      const aiTotal = payload.rows.length;

      // ── Batch mode: when no web search / no competitors / simple rows, batch 20 products per call ──
      const canBatch =
        payload.rows.length > 1 &&
        !payload.webSearch &&
        !(payload.competitorUrls?.length) &&
        !payload.sourcesOnly &&
        payload.rows.every((r) => r.ownerType === 'product');

      if (canBatch) {
        const BATCH_SIZE = 20;
        const rowBatches: typeof payload.rows[] = [];
        for (let i = 0; i < payload.rows.length; i += BATCH_SIZE) {
          rowBatches.push(payload.rows.slice(i, i + BATCH_SIZE));
        }

        for (const batch of rowBatches) {
          await checkDailyAiSpendCap(syncJob.shopId);
          // Load all products in batch
          const products = await Promise.all(
            batch.map((row) => prisma.product.findFirst({
              where: { id: row.ownerId, shopId: syncJob.shopId },
              include: { variants: { take: 1 } },
            })),
          );

          const productLines = products.map((p, i) => {
            if (!p) return `Product ${i + 1}: (not found)`;
            const v = p.variants?.[0];
            return `Product ${i + 1}:
  title: ${p.title}
  handle: ${p.handle}
  vendor: ${p.vendor ?? ''}
  productType: ${p.productType ?? ''}
  descriptionHtml: ${p.descriptionHtml?.slice(0, 400) ?? ''}
  sku: ${v?.sku ?? ''}
  price: ${v?.price ?? ''}`;
          }).join('\n\n');

          const batchPrompt = `${masterPrompt}${aiIntroduction.trim() ? `\n\nWEBSHOPPEN:\n${aiIntroduction.trim()}` : ''}

Du skal generere feltværdien "${fieldDefinition.label}" for hvert af de ${batch.length} produkter herunder.

Instruktion: ${payload.promptTemplate}

Regler for output:
- Returnér PRÆCIST et JSON-array med ${batch.length} strings — én per produkt i samme rækkefølge.
- Eksempel format: ["værdi for produkt 1", "værdi for produkt 2", ...]
- Ingen forklaringer, ingen nøgler, kun arrayet.${outputIsHtml ? '' : '\n- Ren tekst uden HTML.'}

PRODUKTER:
${productLines}`;

          let batchResults: string[] | null = null;
          try {
            const aiResult = await callOpenAi(openAiApiKey, batchPrompt, { webSearchEnabled: false });
            const raw = aiResult.text.trim();
            const jsonMatch = raw.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              if (Array.isArray(parsed) && parsed.length === batch.length) {
                batchResults = parsed.map(String);
              }
            }
          } catch { /* fall through to per-product below */ }

          const rowsToProcessIndividually: typeof payload.rows = [];

          if (batchResults) {
            for (let i = 0; i < batch.length; i++) {
              const row = batch[i]!;
              const suggested = outputIsHtml ? stripMarkdownCodeFences(batchResults[i] ?? '') : (batchResults[i] ?? '');
              const relationIds = getFieldValueRelationIds(row);
              await prisma.fieldValue.upsert({
                where: { ownerType_ownerId_fieldDefinitionId: { ownerType: row.ownerType, ownerId: row.ownerId, fieldDefinitionId: payload.fieldDefinitionId } },
                update: { valueJson: suggested, source: 'ai', updatedByUserId: userId },
                create: { ownerType: row.ownerType, ownerId: row.ownerId, productId: relationIds.productId, variantId: relationIds.variantId, fieldDefinitionId: payload.fieldDefinitionId, valueJson: suggested, source: 'ai', updatedByUserId: userId },
              });
              if (relationIds.productId) {
                await prisma.product.update({ where: { id: relationIds.productId }, data: { updatedAt: new Date() } });
              }
              aiProcessed++;
            }
            await prisma.syncJob.update({
              where: { id: syncJobId },
              data: { payloadJson: { ...(payload as Record<string, unknown>), aiProcessed, aiTotal } as any },
            });
            const freshCheck = await prisma.syncJob.findUnique({ where: { id: syncJobId }, select: { payloadJson: true } });
            if ((freshCheck?.payloadJson as Record<string, unknown> | null)?.cancelRequested === true) break;
          } else {
            // batch parse failed — fall back to individual for this batch
            rowsToProcessIndividually.push(...batch);
          }

          // Individual fallback for failed batches (minimal — reuse same logic below)
          for (const row of rowsToProcessIndividually) {
            const relationIds = getFieldValueRelationIds(row);
            const product = row.ownerType === 'product'
              ? await prisma.product.findFirst({ where: { id: row.ownerId, shopId: syncJob.shopId }, include: { variants: true } })
              : null;
            if (!product) { aiProcessed++; continue; }
            const v = product.variants?.[0] ?? null;
            const vars = { title: product.title, handle: product.handle, vendor: product.vendor ?? '', productType: product.productType ?? '', descriptionHtml: product.descriptionHtml ?? '', sku: v?.sku ?? '', price: v?.price ?? '', collections: '' };
            const rendered = renderPrompt(payload.promptTemplate, vars);
            const singlePrompt = `${masterPrompt}\n\n${rendered}`;
            const res = await callOpenAi(openAiApiKey, singlePrompt, { webSearchEnabled: false });
            const suggested = outputIsHtml ? stripMarkdownCodeFences(res.text) : res.text;
            await prisma.fieldValue.upsert({
              where: { ownerType_ownerId_fieldDefinitionId: { ownerType: row.ownerType, ownerId: row.ownerId, fieldDefinitionId: payload.fieldDefinitionId } },
              update: { valueJson: suggested, source: 'ai', updatedByUserId: userId },
              create: { ownerType: row.ownerType, ownerId: row.ownerId, productId: relationIds.productId, variantId: relationIds.variantId, fieldDefinitionId: payload.fieldDefinitionId, valueJson: suggested, source: 'ai', updatedByUserId: userId },
            });
            if (relationIds.productId) await prisma.product.update({ where: { id: relationIds.productId }, data: { updatedAt: new Date() } });
            aiProcessed++;
          }
        }

        // Email + done for batch mode path
        const notifyEmailBatch = (payload as Record<string, unknown>).notifyEmail as string | undefined;
        if (notifyEmailBatch && aiProcessed > 0) {
          await sendBulkDoneEmail(
            notifyEmailBatch,
            `AI-generering færdig — ${aiProcessed} produkter`,
            `<html><body style="font-family:sans-serif;max-width:560px;margin:40px auto;padding:20px">
              <h2 style="color:#4f46e5">AI-generering færdig</h2>
              <p><strong>${aiProcessed}</strong> af ${aiTotal} produkter opdateret med "<strong>${fieldDefinition.label}</strong>".</p>
              <p><a href="${env.APP_BASE_URL ?? ''}/dashboard/products">Åbn produktlisten →</a></p>
            </body></html>`,
          );
        }
        await markJobDone(syncJobId);
        return;
      }

      for (const row of payload.rows) {
        await checkDailyAiSpendCap(syncJob.shopId);
        const relationIds = getFieldValueRelationIds(row);

        // ── Load entity and build variables ──────────────────────────────────
        let variables: Record<string, string>;
        let entityProductId: string | null = null; // for source lookups

        if (row.ownerType === 'collection') {
          const coll = await prisma.collection.findFirst({ where: { id: row.ownerId, shopId: syncJob.shopId } });
          if (!coll) throw new Error(`AI row owner not found: collection:${row.ownerId}`);
          variables = {
            title: coll.title ?? '',
            handle: coll.handle ?? '',
            descriptionHtml: coll.descriptionHtml ?? '',
          };
        } else {
          const product =
            row.ownerType === 'product'
              ? await prisma.product.findFirst({ where: { id: row.ownerId, shopId: syncJob.shopId }, include: { variants: true } })
              : await prisma.variant
                  .findFirst({ where: { id: row.ownerId, product: { shopId: syncJob.shopId } }, include: { product: { include: { variants: true } } } })
                  .then((variant) => variant?.product ?? null);

          const variant =
            row.ownerType === 'variant'
              ? await prisma.variant.findFirst({ where: { id: row.ownerId, product: { shopId: syncJob.shopId } } })
              : product?.variants?.[0] ?? null;

          if (!product) {
            throw new Error(`AI row owner not found: ${row.ownerType}:${row.ownerId}`);
          }

          entityProductId = product.id;

          // Fetch product's collections for category-aware generation
          let collectionsValue = '';
          try {
            const productCollections = await prisma.productCollection.findMany({
              where: { productId: product.id },
              include: { collection: { select: { title: true, handle: true } } },
              take: 20,
            });
            collectionsValue = productCollections
              .map((pc) => pc.collection.title)
              .filter(Boolean)
              .join(', ');
          } catch {
            // ProductCollection table may not exist in all environments
          }

          variables = {
            title: product.title ?? '',
            handle: product.handle ?? '',
            vendor: product.vendor ?? '',
            productType: product.productType ?? '',
            status: product.status ?? '',
            descriptionHtml: product.descriptionHtml ?? '',
            sku: variant?.sku ?? '',
            barcode: variant?.barcode ?? '',
            price: variant?.price ?? '',
            compareAtPrice: variant?.compareAtPrice ?? '',
            weight: variant?.weight != null ? String(variant.weight) : '',
            weightUnit: variant?.weightUnit ?? '',
            hsCode: variant?.hsCode ?? '',
            countryOfOrigin: variant?.countryOfOrigin ?? '',
            collections: collectionsValue,
          };
        }

        // Inject supplier/source data as prompt variables and context block
        const selectedSourceIds: string[] = Array.isArray(payload.sourceIds) ? payload.sourceIds : [];
        const activeSources = await prisma.source.findMany({
          where: {
            shopId: syncJob.shopId,
            active: true,
            ...(selectedSourceIds.length > 0 ? { id: { in: selectedSourceIds } } : {}),
          },
          select: { id: true, name: true, tagsJson: true, url: true },
        });
        const supplierRows = entityProductId ? findSupplierRowsForProduct(activeSources, { id: entityProductId } as any) : [];
        // Crawled live_url feeds (stored in SourceDataRow)
        const crawledRows = entityProductId ? await findCrawledSourceRows(activeSources, entityProductId) : [];
        // Real-time live_lookup sources (fetched at generation time per product)
        const liveLookupRows = await fetchLiveLookupRows(activeSources, variables);
        const allSourceRows = [...supplierRows, ...crawledRows, ...liveLookupRows];
        const supplierVariables: Record<string, string> = {};
        for (const { rowData } of allSourceRows) {
          for (const [col, value] of Object.entries(rowData)) {
            if (value.trim() && !variables[col]) {
              supplierVariables[`supplier_${col}`] = value;
            }
          }
        }
        const allVariables = { ...variables, ...supplierVariables };

        const supplierContext =
          allSourceRows.length > 0
            ? allSourceRows
                .map(({ sourceName, promptTemplate, rowData }) => {
                  const dataLines = Object.entries(rowData)
                    .filter(([, v]) => v.trim())
                    .map(([k, v]) => `  ${k}: ${v}`)
                    .join('\n');
                  const sourceData = `[${sourceName}]\n${dataLines}`;
                  if (promptTemplate) {
                    return '\n\n' + promptTemplate
                      .replace(/\{\{\s*source_name\s*\}\}/g, sourceName)
                      .replace(/\{\{\s*source_data\s*\}\}/g, sourceData);
                  }
                  return `\n\nKILDEDATA fra "${sourceName}" (brug som faktabasis — reformulér med egne ord):\n${sourceData}`;
                })
                .join('')
            : '';

        const renderedPrompt = renderPrompt(payload.promptTemplate, allVariables);
        const competitorContext = (payload.competitorUrls ?? []).length
          ? `\n\nKONKURRENT-LINKS (brug disse i din research):\n${(payload.competitorUrls ?? []).map((url) => `- ${url}`).join('\n')}`
          : '';
        const webSearchContext = payload.webSearch
          ? '\n\nWEB SØGNING: Aktivér web-søgning og brug aktuel information fra relevante kilder, inkl. konkurrent-links hvor muligt.'
          : '';

        const shouldRunDueDiligence = payload.webSearch === true || (payload.competitorUrls ?? []).length > 0;

        let dueDiligenceNotes = '';
        let dueDiligenceUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

        if (shouldRunDueDiligence) {
          const ddPrompt = buildDueDiligencePrompt({
            renderedPrompt,
            competitorUrls: payload.competitorUrls ?? [],
            variables,
          });
          const ddResult = await callOpenAi(openAiApiKey, ddPrompt, { webSearchEnabled: true });
          dueDiligenceNotes = stripMarkdownCodeFences(ddResult.text);
          dueDiligenceUsage = ddResult.usage;
        }

        const dueDiligenceContext = dueDiligenceNotes
          ? `\n\nDUE DILIGENCE NOTER (research):\n${dueDiligenceNotes}\n\nBrug noterne som input til prioritering og vinkling. Kopiér aldrig konkurrenttekst direkte.`
          : '';

        const sourcesOnlyInstruction = payload.sourcesOnly && allSourceRows.length > 0
          ? '\n\nVIGTIGT — BRUG UDELUKKENDE KILDEDATA: Du må KUN bruge information fra kildedataene herunder. Tilføj ikke viden, antagelser eller formuleringsvalg der ikke direkte kan udledes af kildedata. Mangler der data til et felt, så skriv det eksplicit frem for at opfinde det.'
          : '';
        const noHtmlInstruction = outputIsHtml
          ? ''
          : '\n\nVIGTIGT: Returnér UDELUKKENDE ren tekst. Brug IKKE HTML-tags, markdown eller anden formatering.';
        const shopIntroContext = aiIntroduction.trim()
          ? `\n\nWEBSHOPPEN:\n${aiIntroduction.trim()}`
          : '';
        // Order: role+rules → shop context → task+product data → raw source facts → research notes → constraints
        const finalPrompt = `${masterPrompt}${shopIntroContext}\n\n${renderedPrompt}${supplierContext}${dueDiligenceContext}${sourcesOnlyInstruction}${noHtmlInstruction}`;
        const generationUsesWebSearch = false; // web search only runs in the due-diligence pre-pass, never in the final generation call
        const aiResult = await callOpenAi(openAiApiKey, finalPrompt, { webSearchEnabled: generationUsesWebSearch });
        const suggested = outputIsHtml ? stripMarkdownCodeFences(aiResult.text) : aiResult.text;

        await prisma.fieldValue.upsert({
          where: {
            ownerType_ownerId_fieldDefinitionId: {
              ownerType: row.ownerType,
              ownerId: row.ownerId,
              fieldDefinitionId: payload.fieldDefinitionId,
            },
          },
          update: {
            valueJson: suggested,
            source: 'ai',
            updatedByUserId: userId,
          },
          create: {
            ownerType: row.ownerType,
            ownerId: row.ownerId,
            productId: relationIds.productId,
            variantId: relationIds.variantId,
            fieldDefinitionId: payload.fieldDefinitionId,
            valueJson: suggested,
            source: 'ai',
            updatedByUserId: userId,
          },
        });

        // Touch product.updatedAt so isPendingSync triggers on the product page
        if (relationIds.productId) {
          await prisma.product.update({
            where: { id: relationIds.productId },
            data: { updatedAt: new Date() },
          });
        }

        aiProcessed++;
        // Update progress and check for cancellation
        const { cancelRequested: _dropped, ...restPayload } = payload as Record<string, unknown>;
        void _dropped;
        await prisma.syncJob.update({
          where: { id: syncJobId },
          data: {
            payloadJson: {
              ...restPayload,
              aiProcessed,
              aiTotal,
            },
          },
        });
        // Check if cancellation was requested
        const freshJob = await prisma.syncJob.findUnique({
          where: { id: syncJobId },
          select: { payloadJson: true },
        });
        if ((freshJob?.payloadJson as Record<string, unknown> | null)?.cancelRequested === true) {
          break;
        }

        const shopId =
          row.ownerType === 'product'
            ? (await prisma.product.findFirst({ where: { id: row.ownerId, shopId: syncJob.shopId }, select: { shopId: true } }))?.shopId
            : row.ownerType === 'collection'
              ? (await prisma.collection.findFirst({ where: { id: row.ownerId, shopId: syncJob.shopId }, select: { shopId: true } }))?.shopId
              : (await prisma.variant.findFirst({ where: { id: row.ownerId, product: { shopId: syncJob.shopId } }, include: { product: true } }))
                  ?.product.shopId;

        if (shopId) {
          const occurredAt = new Date();
          const monthKey = monthKeyFromDateUtc(occurredAt);
          const usageIdempotencyKey = `${syncJobId}:${row.ownerType}:${row.ownerId}:${payload.fieldDefinitionId}`;

          const totalPromptTokens = aiResult.usage.promptTokens + dueDiligenceUsage.promptTokens;
          const totalCompletionTokens = aiResult.usage.completionTokens + dueDiligenceUsage.completionTokens;
          const totalTokens = aiResult.usage.totalTokens + dueDiligenceUsage.totalTokens;
          const webSearchCalls = shouldRunDueDiligence ? 1 : 0;
          const cost = estimateOpenAiCost(totalPromptTokens, totalCompletionTokens, webSearchCalls);

          await prisma.changeLog.create({
            data: {
              shopId,
              entityType: row.ownerType,
              entityId: row.ownerId,
              fieldKey: payload.fieldDefinitionId,
              source: 'ai',
              userId,
              jobId: syncJobId,
              afterJson: { suggested },
            },
          });

          await createAiUsageSafe({
            shopId,
            productId: relationIds.productId,
            userId,
            feature: 'ai_apply',
            provider: 'openai',
            model: env.OPENAI_MODEL,
            promptTokens: totalPromptTokens,
            completionTokens: totalCompletionTokens,
            totalTokens,
            estimatedCostUsd: cost.usd,
            estimatedCostDkk: cost.dkk,
            metadataJson: {
              ownerType: row.ownerType,
              ownerId: row.ownerId,
              fieldDefinitionId: payload.fieldDefinitionId,
              webSearch: payload.webSearch === true,
              dueDiligenceUsed: shouldRunDueDiligence,
              webSearchCalls,
              competitorUrlsCount: (payload.competitorUrls ?? []).length,
            },
          });

          const usageBefore = await (prisma as any).usageEvent?.aggregate?.({
            where: {
              shopId,
              billingMonth: monthKey,
              type: 'ai_datapoint_generated',
            },
            _sum: { quantity: true },
          });

          const previousConsumedUnits = Number(usageBefore?._sum?.quantity ?? 0);

          const eventResult = await createUsageEventSafe({
            shopId,
            occurredAt,
            monthKey,
            idempotencyKey: usageIdempotencyKey,
            quantity: 1,
            metadataJson: {
              eventSource: 'ai_apply',
              syncJobId,
              ownerType: row.ownerType,
              ownerId: row.ownerId,
              fieldDefinitionId: payload.fieldDefinitionId,
            },
          });

          if (eventResult.created) {
            const subscription = await (prisma as any).shopSubscription?.findUnique?.({
              where: { shopId },
              select: { includedUnitsPerMonth: true },
            });

            const includedUnits = Number(subscription?.includedUnitsPerMonth ?? 100);
            const nextConsumedUnits = previousConsumedUnits + 1;

            if (
              shouldEmitIncludedReachedNotice({
                previousConsumedUnits,
                nextConsumedUnits,
                includedUnitsPerMonth: includedUnits,
              })
            ) {
              await createUsageNoticeIfMissing({
                shopId,
                monthKey,
                kind: 'included_reached_100',
                consumedUnits: nextConsumedUnits,
                includedUnits,
              });
            }

            if (
              shouldEmitOverageStartedNotice({
                previousConsumedUnits,
                nextConsumedUnits,
                includedUnitsPerMonth: includedUnits,
              })
            ) {
              await createUsageNoticeIfMissing({
                shopId,
                monthKey,
                kind: 'overage_started',
                consumedUnits: nextConsumedUnits,
                includedUnits,
              });
            }
          }
        }
      }

      // Send email notification if requested
      const notifyEmail = (payload as Record<string, unknown>).notifyEmail as string | undefined;
      if (notifyEmail && aiProcessed > 0) {
        const fieldLabel = fieldDefinition.label;
        await sendBulkDoneEmail(
          notifyEmail,
          `AI-generering færdig — ${aiProcessed} produkter`,
          `<html><body style="font-family:sans-serif;max-width:560px;margin:40px auto;padding:20px">
            <h2 style="color:#4f46e5">AI-generering færdig</h2>
            <p>Batchen er afsluttet:</p>
            <ul>
              <li><strong>Felt:</strong> ${fieldLabel}</li>
              <li><strong>Produkter behandlet:</strong> ${aiProcessed} af ${aiTotal}</li>
            </ul>
            <p>Åbn <a href="${env.APP_BASE_URL ?? ''}/dashboard/products">produktlisten</a> for at se resultaterne.</p>
          </body></html>`,
        );
      }

      await markJobDone(syncJobId);
    } catch (error) {
      await markJobFailed(syncJobId, error);
      throw error;
    }
  },
  { connection },
);

// ---------------------------------------------------------------------------
// Alt-text worker — bulk image alt-text via GPT-4o Vision
// ---------------------------------------------------------------------------
const altTextWorker = new Worker(
  'alt-text-jobs',
  async (job: Job<SyncJobRef>) => {
    const { syncJobId } = job.data;
    await markJobRunning(syncJobId);
    const syncJob = await prisma.syncJob.findUnique({ where: { id: syncJobId } });
    if (!syncJob) throw new Error('SyncJob not found');

    try {
      const payload = syncJob.payloadJson as {
        productIds: string[];
        notifyEmail?: string;
      };

      const platformKeyRow = await prisma.platformSetting.findUnique({ where: { key: 'openai_api_key' } });
      const encryptedPlatformKey = typeof (platformKeyRow?.valueJson as any)?.encryptedKey === 'string'
        ? (platformKeyRow!.valueJson as any).encryptedKey as string
        : null;
      if (!encryptedPlatformKey) throw new Error('Platform OpenAI API key not configured');
      const openAiApiKey = decryptSecret(encryptedPlatformKey, env.MASTER_ENCRYPTION_KEY);

      let processed = 0;
      const total = payload.productIds.length;

      for (const productId of payload.productIds) {
        await checkDailyAiSpendCap(syncJob.shopId);
        const product = await prisma.product.findFirst({
          where: { id: productId, shopId: syncJob.shopId },
          select: { id: true, title: true, imagesJson: true },
        });
        if (!product) continue;

        const images = (product.imagesJson ?? []) as Array<{ url: string; altText?: string | null }>;
        if (images.length === 0) { processed++; continue; }

        const newImages = [...images];
        let changed = false;
        for (let i = 0; i < Math.min(newImages.length, 5); i++) {
          const img = newImages[i]!;
          if (img.altText) continue; // skip if already has alt text
          try {
            const altText = await callOpenAiVision(
              openAiApiKey,
              img.url,
              `Du er en e-commerce specialist. Skriv en kort, præcis alt-tekst på dansk til dette produktbillede for "${product.title}". Max 125 tegn. Kun alt-teksten, ingen forklaringer.`,
            );
            if (altText) {
              newImages[i] = { ...img, altText };
              changed = true;
            }
          } catch { /* skip this image */ }
        }

        if (changed) {
          await prisma.product.update({
            where: { id: product.id },
            data: { imagesJson: newImages as any, updatedAt: new Date() },
          });
        }

        processed++;
        await prisma.syncJob.update({
          where: { id: syncJobId },
          data: { payloadJson: { ...payload, altTextProcessed: processed, altTextTotal: total } as any },
        });

        // cancellation check
        const fresh = await prisma.syncJob.findUnique({ where: { id: syncJobId }, select: { payloadJson: true } });
        if ((fresh?.payloadJson as Record<string, unknown> | null)?.cancelRequested === true) break;
      }

      if (payload.notifyEmail && processed > 0) {
        await sendBulkDoneEmail(
          payload.notifyEmail,
          `Alt-tekst generering færdig — ${processed} produkter`,
          `<html><body style="font-family:sans-serif;max-width:560px;margin:40px auto;padding:20px">
            <h2 style="color:#4f46e5">Alt-tekst generering færdig</h2>
            <p><strong>${processed}</strong> af ${total} produkter har fået alt-tekst på billeder.</p>
            <p><a href="${env.APP_BASE_URL ?? ''}/dashboard/products">Åbn produktlisten →</a></p>
          </body></html>`,
        );
      }

      await markJobDone(syncJobId);
    } catch (error) {
      await markJobFailed(syncJobId, error);
      throw error;
    }
  },
  { connection },
);

logger.info('EL-PIM worker started');

// ---------------------------------------------------------------------------
// Feed crawl queue + scheduler
// ---------------------------------------------------------------------------
type FeedCrawlRef = { sourceId: string };

const feedCrawlQueue = new Queue<FeedCrawlRef>('feed-crawl', { connection });

const feedCrawlWorker = new Worker<FeedCrawlRef>(
  'feed-crawl',
  async (job) => {
    const { sourceId } = job.data;
    logger.info({ sourceId, jobId: job.id }, 'Feed crawl job started');
    try {
      const result = await crawlFeed(sourceId);
      logger.info({ sourceId, ...result }, 'Feed crawl job completed');
      return result;
    } catch (error) {
      logger.error({ sourceId, err: error }, 'Feed crawl job failed');
      // Mark source as failed
      try {
        const source = await prisma.source.findUnique({ where: { id: sourceId } });
        if (source) {
          const meta = source.tagsJson && typeof source.tagsJson === 'object' && !Array.isArray(source.tagsJson)
            ? source.tagsJson as Record<string, unknown>
            : {};
          await prisma.source.update({
            where: { id: sourceId },
            data: {
              tagsJson: {
                ...meta,
                crawlStatus: 'failed',
                crawlError: error instanceof Error ? error.message : 'Ukendt fejl',
              } as any,
            },
          });
        }
      } catch (updateErr) {
        logger.error({ sourceId, err: updateErr }, 'Failed to update source crawl status');
      }
      throw error;
    }
  },
  {
    connection,
    concurrency: 2,
    // Large feeds (1-2 GB) can take 20-30 min. Lock must outlive the job.
    // BullMQ auto-renews every lockDuration/2, so a 25-min lock renews every ~12 min.
    lockDuration: 25 * 60_000,
  },
);

// Schedule repeatable crawl jobs for active live_url sources
const CRAWL_FREQUENCIES: Record<string, number> = {
  daily: 24 * 60 * 60_000,
  every_3_days: 3 * 24 * 60 * 60_000,
  weekly: 7 * 24 * 60 * 60_000,
};

async function scheduleFeedCrawls(): Promise<void> {
  try {
    const sources = await prisma.source.findMany({
      where: { active: true },
      select: { id: true, url: true, shopId: true, tagsJson: true },
    });

    // Build set of shops with active subscription — skip crawling for inactive shops
    const shopIds = [...new Set(sources.map((s) => s.shopId))];
    const activeShops = await prisma.shopSubscription.findMany({
      where: { shopId: { in: shopIds }, status: 'active' },
      select: { shopId: true },
    });
    const activeShopIds = new Set(activeShops.map((s: { shopId: string }) => s.shopId));

    for (const source of sources) {
      if (!activeShopIds.has(source.shopId)) continue;
      const meta = source.tagsJson as Record<string, unknown> | null;
      if (!meta || typeof meta !== 'object') continue;
      const feedType = meta.feedType as string | undefined;
      if (feedType !== 'live_url') continue;
      // Legacy sources with type 'web' and a URL also qualify
      if (meta.type === 'web' && !source.url.startsWith('http')) continue;

      const frequency = (meta.crawlFrequency as string) ?? 'weekly';
      const intervalMs = CRAWL_FREQUENCIES[frequency] ?? CRAWL_FREQUENCIES.weekly;

      // Check last crawl time
      const lastCrawlAt = typeof meta.lastCrawlAt === 'string' ? new Date(meta.lastCrawlAt).getTime() : 0;
      const elapsed = Date.now() - lastCrawlAt;

      if (elapsed >= intervalMs) {
        // Enqueue crawl (deduplicated by jobId)
        await feedCrawlQueue.add(
          'crawl',
          { sourceId: source.id },
          { jobId: `crawl-${source.id}-${Math.floor(Date.now() / intervalMs)}`, removeOnComplete: 50, removeOnFail: 20 },
        );
        logger.info({ sourceId: source.id, frequency }, 'Scheduled feed crawl');
      }
    }
  } catch (error) {
    logger.error({ err: error }, 'Failed to schedule feed crawls');
  }
}

// Run scheduler on startup + every 6 hours
void scheduleFeedCrawls();
setInterval(() => void scheduleFeedCrawls(), 6 * 60 * 60_000);

// ─── Inbound delta sync scheduler ──────────────────────────────────────────
// Lightweight webhook fallback: fetches products updated in the last 30 min
// from each connected shop every 15 minutes, applying conflict detection.
const deltaSyncQueue = new Queue('sync-jobs', { connection });

async function scheduleInboundDeltaSync(): Promise<void> {
  try {
    const since = new Date(Date.now() - 30 * 60_000).toISOString();
    const shops = await prisma.shop.findMany({
      where: { status: 'connected' },
      select: { id: true },
    });
    for (const shop of shops) {
      // Deduplicate: one delta sync job per shop per 15-min window
      const windowKey = Math.floor(Date.now() / (15 * 60_000));
      const jobId = `delta-sync-${shop.id}-${windowKey}`;
      const existing = await prisma.syncJob.findFirst({
        where: { shopId: shop.id, type: 'inbound_delta_sync', status: { in: ['queued', 'running'] } },
      });
      if (existing) continue;
      const syncJob = await prisma.syncJob.create({
        data: { shopId: shop.id, type: 'inbound_delta_sync', payloadJson: { since } },
      });
      await deltaSyncQueue.add('delta-sync', { syncJobId: syncJob.id }, { jobId, removeOnComplete: 5, removeOnFail: 5 });
      logger.info({ shopId: shop.id, since }, 'Scheduled delta sync');
    }
  } catch (error) {
    logger.error({ err: error }, 'Failed to schedule delta sync');
  }
}

void scheduleInboundDeltaSync();
setInterval(() => void scheduleInboundDeltaSync(), 15 * 60_000);

// ── Run Campaign Worker ────────────────────────────────────────────────────

type RunCampaignJobRef = { syncJobId: string };

const runCampaignQueue = new Queue<RunCampaignJobRef>('run-campaign', { connection });

// System fields that live on the Product record itself (not in FieldValue)
const RC_SYSTEM_FIELDS = [
  { id: '__title',           label: 'Titel',                    type: 'text', defaultPrompt: 'Generer en præcis og SEO-venlig produkttitel. Returnér kun titlen som ren tekst.' },
  { id: '__description',     label: 'Beskrivelse',              type: 'html', defaultPrompt: 'Generer en overbevisende produktbeskrivelse som HTML (brug <p>, <ul>, <li> osv.).' },
  { id: '__seo_title',       label: 'Meta titel (SEO)',         type: 'text', defaultPrompt: 'Generer en SEO meta-titel. Max 60 tegn. Returnér kun titlen som ren tekst.' },
  { id: '__seo_description', label: 'Meta beskrivelse (SEO)',   type: 'text', defaultPrompt: 'Generer en SEO meta-beskrivelse. Max 160 tegn. Returnér kun beskrivelsen som ren tekst.' },
] as const;

function getSystemFieldCurrentValue(product: { title: string; descriptionHtml?: string | null; seoJson: unknown }, fieldId: string): string | null {
  if (fieldId === '__title') return product.title || null;
  if (fieldId === '__description') return product.descriptionHtml || null;
  const seo = (product.seoJson as Record<string, string> | null) ?? {};
  if (fieldId === '__seo_title') return seo.title || null;
  if (fieldId === '__seo_description') return seo.description || null;
  return null;
}

async function writeSystemField(productId: string, fieldId: string, value: string): Promise<void> {
  if (fieldId === '__title') {
    await prisma.product.update({ where: { id: productId }, data: { title: value } });
  } else if (fieldId === '__description') {
    await prisma.product.update({ where: { id: productId }, data: { descriptionHtml: value } });
  } else if (fieldId === '__seo_title' || fieldId === '__seo_description') {
    const prod = await prisma.product.findUnique({ where: { id: productId }, select: { seoJson: true } });
    const seo = ((prod?.seoJson ?? {}) as Record<string, string>);
    const updated = fieldId === '__seo_title' ? { ...seo, title: value } : { ...seo, description: value };
    await prisma.product.update({ where: { id: productId }, data: { seoJson: updated } });
  }
}

async function logCampaign(campaignId: string, level: string, message: string, metaJson?: Record<string, unknown>, itemId?: string): Promise<void> {
  try {
    await (prisma as any).runCampaignLog.create({ data: { campaignId, itemId: itemId ?? null, level, message, metaJson: metaJson ?? null } });
  } catch { /* ignore log failures */ }
}

const runCampaignWorker = new Worker<RunCampaignJobRef>(
  'run-campaign',
  async (job) => {
    const { syncJobId } = job.data;
    await markJobRunning(syncJobId);
    const syncJob = await prisma.syncJob.findUnique({ where: { id: syncJobId } });
    if (!syncJob) throw new Error('SyncJob not found');

    const { campaignId } = syncJob.payloadJson as { campaignId: string };

    const campaign = await (prisma as any).runCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign) { await markJobFailed(syncJobId, new Error('Campaign not found')); return; }
    if (campaign.status !== 'running') { await markJobDone(syncJobId); return; }

    const fields: string[] = (campaign.fieldsJson as string[]) ?? [];
    const overwrite: string[] = (campaign.overwriteJson as string[]) ?? [];

    // Load field definitions (custom + system)
    const customFieldIds = fields.filter((f: string) => !f.startsWith('__'));
    const systemFieldIds = fields.filter((f: string) => f.startsWith('__'));
    const customFieldDefs = await prisma.fieldDefinition.findMany({
      where: { id: { in: customFieldIds }, shopId: campaign.shopId },
      select: { id: true, label: true, type: true },
    });
    const systemFieldDefs = RC_SYSTEM_FIELDS.filter((sf) => systemFieldIds.includes(sf.id));
    const fieldDefs: Array<{ id: string; label: string; type: string; defaultPrompt?: string }> = [...customFieldDefs, ...systemFieldDefs];

    // Load AI config
    const [aiIntroRow, masterPromptRow, platformKeyRow] = await Promise.all([
      prisma.shopSetting.findUnique({ where: { shopId_key: { shopId: campaign.shopId, key: 'ai_introduction' } } }),
      prisma.shopSetting.findUnique({ where: { shopId_key: { shopId: campaign.shopId, key: 'master_prompt' } } }),
      prisma.platformSetting.findUnique({ where: { key: 'openai_api_key' } }),
    ]);

    const aiIntroduction = typeof (aiIntroRow?.valueJson as any) === 'string' ? (aiIntroRow?.valueJson as string) : '';
    const masterPrompt = typeof (masterPromptRow?.valueJson as any) === 'string' ? (masterPromptRow?.valueJson as string) : DEFAULT_MASTER_PROMPT;
    const platformKeyData = ((platformKeyRow?.valueJson ?? {}) as Record<string, unknown>);
    const encryptedPlatformKey = typeof platformKeyData.encryptedKey === 'string' ? platformKeyData.encryptedKey : null;
    if (!encryptedPlatformKey) {
      await logCampaign(campaignId, 'error', 'Platform OpenAI API-nøgle er ikke konfigureret. Gå til Platform → Indstillinger.');
      await (prisma as any).runCampaign.update({ where: { id: campaignId }, data: { status: 'failed' } });
      await markJobFailed(syncJobId, new Error('OpenAI key not configured'));
      return;
    }
    const openAiApiKey = decryptSecret(encryptedPlatformKey, env.MASTER_ENCRYPTION_KEY);

    // Load prompt templates for each field
    const promptsByField: Record<string, string> = {};
    for (const fd of fieldDefs) {
      const pt = await prisma.promptTemplate.findFirst({
        where: { shopId: campaign.shopId, isDefault: true },
        orderBy: { createdAt: 'desc' },
        select: { body: true },
      });
      promptsByField[fd.id] = pt?.body ?? (fd as any).defaultPrompt ?? `Generer ${fd.label} for produktet baseret på titel, type og leverandør.`;
    }

    // Load active sources (same logic as individual AI worker)
    const selectedSourceIds: string[] = (campaign.sourceIdsJson as string[]) ?? [];
    const sourcesOnly: boolean = (campaign as any).sourcesOnly ?? false;
    const activeSources = await prisma.source.findMany({
      where: {
        shopId: campaign.shopId,
        active: true,
        ...(selectedSourceIds.length > 0 ? { id: { in: selectedSourceIds } } : {}),
      },
      select: { id: true, name: true, tagsJson: true, url: true },
    });

    let processedTotal = 0;
    let failedTotal = 0;

    // Process in batches of batchSize
    const ITEM_BATCH = campaign.batchSize as number;

    while (true) {
      // Re-check campaign status (may have been paused externally)
      const fresh = await (prisma as any).runCampaign.findUnique({ where: { id: campaignId }, select: { status: true } });
      if (!fresh || fresh.status !== 'running') {
        await logCampaign(campaignId, 'warn', 'Kørsel stoppet — kampagne er ikke længere i running tilstand.');
        break;
      }

      const pendingItems = await (prisma as any).runCampaignItem.findMany({
        where: { campaignId, status: { in: ['pending', 'failed'] } },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        take: ITEM_BATCH,
      });

      if (pendingItems.length === 0) {
        const totalDone = await (prisma as any).runCampaignItem.count({ where: { campaignId, status: 'done' } });
        const totalFailed = await (prisma as any).runCampaignItem.count({ where: { campaignId, status: 'failed' } });
        const totalSkipped = await (prisma as any).runCampaignItem.count({ where: { campaignId, status: 'skipped' } });
        await (prisma as any).runCampaign.update({
          where: { id: campaignId },
          data: { status: 'done', completedAt: new Date(), doneItems: totalDone, failedItems: totalFailed, skippedItems: totalSkipped },
        });
        await logCampaign(campaignId, 'success', `Kørsel færdig! ${totalDone} behandlet, ${totalFailed} fejlet, ${totalSkipped} sprunget over.`);
        break;
      }

      const batchIds = pendingItems.map((i: any) => i.id);
      await (prisma as any).runCampaignItem.updateMany({ where: { id: { in: batchIds } }, data: { status: 'processing' } });
      await logCampaign(campaignId, 'info', `Behandler batch på ${pendingItems.length} produkter...`);

      // Enrich all products in this batch with full data + source rows (same as individual AI worker)
      const enriched = await Promise.all(pendingItems.map(async (item: any) => {
        const product = await prisma.product.findFirst({
          where: { id: item.productId },
          include: { variants: true },
        });
        if (!product) return { item, product: null, variables: null, allSourceRows: [] as ReturnType<typeof findSupplierRowsForProduct> };

        // Collections
        let collectionsValue = '';
        try {
          const pcs = await prisma.productCollection.findMany({
            where: { productId: product.id },
            include: { collection: { select: { title: true } } },
            take: 20,
          });
          collectionsValue = pcs.map((pc) => pc.collection.title).filter(Boolean).join(', ');
        } catch { /* ignore */ }

        const v = product.variants?.[0] ?? null;
        const variables: Record<string, string> = {
          title: product.title ?? '',
          handle: product.handle ?? '',
          vendor: product.vendor ?? '',
          productType: product.productType ?? '',
          status: product.status ?? '',
          descriptionHtml: product.descriptionHtml ?? '',
          sku: v?.sku ?? '',
          barcode: (v as any)?.barcode ?? '',
          price: (v as any)?.price ?? '',
          compareAtPrice: (v as any)?.compareAtPrice ?? '',
          weight: (v as any)?.weight != null ? String((v as any).weight) : '',
          weightUnit: (v as any)?.weightUnit ?? '',
          collections: collectionsValue,
        };

        // Source rows — identical to individual AI worker
        const supplierRows = findSupplierRowsForProduct(activeSources, { id: product.id, title: product.title, handle: product.handle, vendor: product.vendor, variants: product.variants });
        const crawledRows = await findCrawledSourceRows(activeSources, product.id);
        const liveLookupRows = await fetchLiveLookupRows(activeSources, variables);
        const allSourceRows = [...supplierRows, ...crawledRows, ...liveLookupRows];

        return { item, product, variables, allSourceRows };
      }));

      // Process each field for the whole batch
      for (const fd of fieldDefs) {
        await checkDailyAiSpendCap(campaign.shopId);

        const outputIsHtml = fd.type === 'html';
        const promptTemplate = promptsByField[fd.id] ?? `Generer ${fd.label}.`;

        // Skip products that already have a value (unless overwrite)
        const toProcess: Array<typeof enriched[0] & { batchIndex: number }> = [];
        for (let i = 0; i < enriched.length; i++) {
          const e = enriched[i]!;
          if (!e.product) continue;
          if (!overwrite.includes(fd.id)) {
            let hasExisting = false;
            if (fd.id.startsWith('__')) {
              hasExisting = !!getSystemFieldCurrentValue(e.product, fd.id);
            } else {
              const existing = await prisma.fieldValue.findUnique({
                where: { ownerType_ownerId_fieldDefinitionId: { ownerType: 'product', ownerId: e.product.id, fieldDefinitionId: fd.id } },
                select: { valueJson: true },
              });
              hasExisting = !!(existing?.valueJson && existing.valueJson !== '' && existing.valueJson !== null);
            }
            if (hasExisting) {
              const fieldsDone = (e.item.fieldsDoneJson ?? {}) as Record<string, string>;
              fieldsDone[fd.id] = 'skipped';
              await (prisma as any).runCampaignItem.update({ where: { id: e.item.id }, data: { fieldsDoneJson: fieldsDone } });
              continue;
            }
          }
          toProcess.push({ ...e, batchIndex: i });
        }

        if (toProcess.length === 0) continue;

        // Build rich per-product sections — same context as individual AI worker
        const sourcesOnlyInstruction = sourcesOnly && toProcess.some((e) => e.allSourceRows.length > 0)
          ? '\n\nVIGTIGT — BRUG UDELUKKENDE KILDEDATA: Du må KUN bruge information fra kildedataene herunder. Tilføj ikke viden, antagelser eller formuleringsvalg der ikke direkte kan udledes af kildedata. Mangler der data til et felt, så skriv det eksplicit frem for at opfinde det.'
          : '';
        const noHtmlInstruction = outputIsHtml ? '' : '\n- Ren tekst uden HTML-tags.';

        const productLines = toProcess.map(({ product, variables, allSourceRows }, i) => {
          const v = product!.variants?.[0];
          const lines = [
            `Produkt ${i + 1}:`,
            `  titel: ${variables!.title}`,
            variables!.vendor ? `  leverandør: ${variables!.vendor}` : '',
            variables!.productType ? `  produkttype: ${variables!.productType}` : '',
            variables!.collections ? `  kollektioner: ${variables!.collections}` : '',
            v ? `  sku: ${(v as any).sku ?? ''}` : '',
            v ? `  pris: ${(v as any).price ?? ''}` : '',
            variables!.descriptionHtml ? `  beskrivelse: ${variables!.descriptionHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)}` : '',
          ].filter(Boolean).join('\n');

          const sourceSection = allSourceRows.length > 0
            ? '\n' + allSourceRows.map(({ sourceName, rowData }) => {
                const dataLines = Object.entries(rowData)
                  .filter(([, v]) => String(v).trim())
                  .map(([k, v]) => `    ${k}: ${v}`)
                  .join('\n');
                return `  KILDEDATA fra "${sourceName}":\n${dataLines}`;
              }).join('\n')
            : '';

          return lines + sourceSection;
        }).join('\n\n---\n\n');

        const shopIntroContext = aiIntroduction.trim() ? `\n\nWEBSHOPPEN:\n${aiIntroduction.trim()}` : '';
        const renderedInstruction = renderPrompt(promptTemplate, toProcess[0]?.variables ?? {});

        const batchPrompt = `${masterPrompt}${shopIntroContext}

Du skal generere feltværdien "${fd.label}" for hvert af de ${toProcess.length} produkter herunder.

Instruktion: ${renderedInstruction}

Regler for output:
- Returnér PRÆCIST et JSON-array med ${toProcess.length} strings — én per produkt i samme rækkefølge.
- Format: ["værdi for produkt 1", "værdi for produkt 2", ...]
- Ingen forklaringer, ingen nøgler, kun arrayet.${noHtmlInstruction}${sourcesOnlyInstruction}

PRODUKTER:
${productLines}`;

        let batchResults: string[] | null = null;
        try {
          const aiResult = await callOpenAi(openAiApiKey, batchPrompt, { webSearchEnabled: false });
          const raw = aiResult.text.trim();
          const jsonMatch = raw.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (Array.isArray(parsed) && parsed.length === toProcess.length) {
              batchResults = parsed.map(String);
            }
          }
        } catch (err) {
          await logCampaign(campaignId, 'warn', `Batch AI-kald fejlede for "${fd.label}" — falder tilbage til individuelle kald. Fejl: ${err instanceof Error ? err.message : String(err)}`);
        }

        for (let i = 0; i < toProcess.length; i++) {
          const { item, product, variables, allSourceRows } = toProcess[i]!;
          let suggested: string;

          if (batchResults) {
            suggested = batchResults[i] ?? '';
          } else {
            // Individual fallback — exactly like the individual AI worker
            try {
              const supplierContext = allSourceRows.length > 0
                ? allSourceRows.map(({ sourceName, rowData }) => {
                    const dataLines = Object.entries(rowData).filter(([, v]) => String(v).trim()).map(([k, v]) => `  ${k}: ${v}`).join('\n');
                    return `\n\nKILDEDATA fra "${sourceName}":\n[${sourceName}]\n${dataLines}`;
                  }).join('')
                : '';
              const rendered = renderPrompt(promptTemplate, variables ?? {});
              const finalPrompt = `${masterPrompt}${shopIntroContext}\n\n${rendered}${supplierContext}${sourcesOnlyInstruction}`;
              const res = await callOpenAi(openAiApiKey, finalPrompt, { webSearchEnabled: false });
              suggested = res.text;
            } catch (err) {
              await logCampaign(campaignId, 'error', `Fejl ved ${product!.title} (${fd.label}): ${err instanceof Error ? err.message : String(err)}`, undefined, item.id);
              const fieldsDone = (item.fieldsDoneJson ?? {}) as Record<string, string>;
              fieldsDone[fd.id] = 'failed';
              await (prisma as any).runCampaignItem.update({ where: { id: item.id }, data: { fieldsDoneJson: fieldsDone } });
              continue;
            }
          }

          if (outputIsHtml) suggested = stripMarkdownCodeFences(suggested);

          if (fd.id.startsWith('__')) {
            await writeSystemField(product!.id, fd.id, suggested);
          } else {
            await prisma.fieldValue.upsert({
              where: { ownerType_ownerId_fieldDefinitionId: { ownerType: 'product', ownerId: product!.id, fieldDefinitionId: fd.id } },
              update: { valueJson: suggested, source: 'ai' },
              create: { ownerType: 'product', ownerId: product!.id, productId: product!.id, fieldDefinitionId: fd.id, valueJson: suggested, source: 'ai' },
            });
          }
          await prisma.product.update({ where: { id: product!.id }, data: { updatedAt: new Date() } });

          const fieldsDone = (item.fieldsDoneJson ?? {}) as Record<string, string>;
          fieldsDone[fd.id] = 'done';
          await (prisma as any).runCampaignItem.update({ where: { id: item.id }, data: { fieldsDoneJson: fieldsDone } });
        }
      }

      // Mark all batch items as done/failed
      for (const { item } of enriched) {
        const refreshed = await (prisma as any).runCampaignItem.findUnique({ where: { id: item.id }, select: { fieldsDoneJson: true } });
        const fieldsDone = (refreshed?.fieldsDoneJson ?? {}) as Record<string, string>;
        const allFieldKeys = fieldDefs.map((f: any) => f.id);
        const hasFailure = allFieldKeys.some((k: string) => fieldsDone[k] === 'failed');
        const finalStatus = hasFailure ? 'failed' : 'done';
        await (prisma as any).runCampaignItem.update({ where: { id: item.id }, data: { status: finalStatus, processedAt: new Date() } });
        if (finalStatus === 'done') processedTotal++; else failedTotal++;
      }

      const [nowDone, nowFailed, nowSkipped] = await Promise.all([
        (prisma as any).runCampaignItem.count({ where: { campaignId, status: 'done' } }),
        (prisma as any).runCampaignItem.count({ where: { campaignId, status: 'failed' } }),
        (prisma as any).runCampaignItem.count({ where: { campaignId, status: 'skipped' } }),
      ]);
      await (prisma as any).runCampaign.update({ where: { id: campaignId }, data: { doneItems: nowDone, failedItems: nowFailed, skippedItems: nowSkipped } });
      await logCampaign(campaignId, 'success', `Batch færdig: ${processedTotal} behandlet i alt, ${failedTotal} fejlet.`);
    }

    await markJobDone(syncJobId);
  },
  { connection, concurrency: 1 },
);

// Poll for queued run_campaign jobs every 10 seconds
setInterval(async () => {
  try {
    const jobs = await prisma.syncJob.findMany({
      where: { type: 'run_campaign', status: 'queued' },
      orderBy: { createdAt: 'asc' },
      take: 5,
    });
    for (const job of jobs) {
      const jobId = `run-campaign-${job.id}`;
      await runCampaignQueue.add('run-campaign', { syncJobId: job.id }, { jobId, removeOnComplete: 10, removeOnFail: 10 });
    }
  } catch (err) {
    logger.error({ err }, 'Failed to poll run_campaign jobs');
  }
}, 10_000);

// Export queue for API to enqueue manual crawls
export { feedCrawlQueue };

const healthServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', service: 'worker' }));
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});

healthServer.listen(env.WORKER_HEALTH_PORT, '0.0.0.0', () => {
  logger.info({ port: env.WORKER_HEALTH_PORT }, 'worker health endpoint listening');
});

healthServer.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    logger.warn({ port: env.WORKER_HEALTH_PORT }, 'worker health port already in use; continuing without binding health endpoint');
    return;
  }
  logger.error({ error }, 'worker health server failed');
});

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'Graceful shutdown initiated');
  await Promise.allSettled([
    syncWorker.close(),
    webhookWorker.close(),
    importWorker.close(),
    aiWorker.close(),
    altTextWorker.close(),
    feedCrawlWorker.close(),
    runCampaignWorker.close(),
  ]);
  healthServer.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
