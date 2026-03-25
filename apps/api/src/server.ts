import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import rawBody from 'fastify-raw-body';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '@epim/db';
import {
  aiKeywordSuggestionSchema,
  aiPreviewSchema,
  bulkPatchSchema,
  calculateMonthlyCharge,
  connectShopSchema,
  fieldDefinitionSchema,
  loginSchema,
  mappingSchema,
  monthKeyFromDateUtc,
  openAiKeySchema,
  parseMonthKey,
  productPatchSchema,
  collectionPatchSchema,
  registerSchema,
  variantPatchSchema,
  resolveConflict,
} from '@epim/shared';
import { decryptSecret, encryptSecret } from '@epim/crypto';
import { ShopifyGraphQLClient, registerShopWebhooks, verifyShopifyWebhook } from '@epim/shopify';
import { env } from './config.js';
import { hashPassword, verifyPassword } from './auth.js';
import { aiQueue, altTextQueue, feedCrawlQueue, importQueue, syncQueue, webhookQueue } from './queue.js';
import { createSnapshotAndLog } from './snapshot.js';
import { buildBillingCloseBreakdown } from './billing-close.js';
import { isUniqueConstraintError } from './stripe-utils.js';

const app = Fastify({ logger: true });

const USD_TO_DKK = 6.9;
const OPENAI_INPUT_USD_PER_1K = 0.00015;
const OPENAI_OUTPUT_USD_PER_1K = 0.0006;
let productCollectionTableAvailable: boolean | null = null;

const hasProductCollectionTable = async (): Promise<boolean> => {
  if (productCollectionTableAvailable != null) {
    return productCollectionTableAvailable;
  }
  try {
    await prisma.$queryRawUnsafe('SELECT 1 FROM "ProductCollection" LIMIT 1');
    productCollectionTableAvailable = true;
  } catch {
    productCollectionTableAvailable = false;
  }
  return productCollectionTableAvailable;
};

const estimateOpenAiCost = (promptTokens: number, completionTokens: number): { usd: number; dkk: number } => {
  const usd = (promptTokens / 1000) * OPENAI_INPUT_USD_PER_1K + (completionTokens / 1000) * OPENAI_OUTPUT_USD_PER_1K;
  return { usd, dkk: usd * USD_TO_DKK };
};

const sendMagicLink = async (opts: {
  userId: string;
  email: string;
  redirectTo: string;
  baseUrl: string;
}): Promise<void> => {
  const { randomBytes } = await import('node:crypto');
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min

  await prisma.magicLinkToken.create({
    data: { userId: opts.userId, token, expiresAt, redirectTo: opts.redirectTo },
  });

  const url = `${opts.baseUrl}/auth/verify?token=${token}`;

  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    throw new Error('Email er ikke konfigureret. Kontakt support.');
  }

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: opts.email,
      subject: 'Din adgangslink til EL-PIM',
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:40px 24px">
          <div style="margin-bottom:32px">
            <span style="font-size:22px;font-weight:700;color:#1e293b">EL-PIM</span>
          </div>
          <h1 style="font-size:20px;font-weight:700;color:#1e293b;margin:0 0 8px">Log ind på EL-PIM</h1>
          <p style="color:#475569;font-size:15px;line-height:1.6;margin:0 0 24px">
            Klik på knappen nedenfor for at logge ind. Linket er gyldigt i 30 minutter.
          </p>
          <a href="${url}" style="display:inline-block;background:#4f46e5;color:#fff;font-size:15px;font-weight:600;text-decoration:none;padding:12px 28px;border-radius:10px">
            Log ind på EL-PIM
          </a>
          <p style="color:#94a3b8;font-size:13px;margin:32px 0 0">
            Eller kopier dette link ind i din browser:<br>
            <a href="${url}" style="color:#6366f1;word-break:break-all">${url}</a>
          </p>
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:32px 0">
          <p style="color:#cbd5e1;font-size:12px;margin:0">
            Hvis du ikke har anmodet om dette link, kan du blot ignorere denne e-mail.<br>
            © ${new Date().getFullYear()} EL-PIM · <a href="https://el-grossisten.dk" style="color:#cbd5e1">el-grossisten.dk</a>
          </p>
        </div>
      `,
    }),
  });
};

const sendBillingNoticeEmail = async (args: {
  recipients: string[];
  subject: string;
  html: string;
}): Promise<void> => {
  if (!args.recipients.length) {
    return;
  }

  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    throw new Error('RESEND_API_KEY or EMAIL_FROM is not configured in API environment');
  }

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
    throw new Error(`Resend email failed: ${response.status} ${text}`);
  }
};

const createBillingOpsAudit = async (args: {
  userId: string;
  action: string;
  targetType: string;
  targetId: string;
  metadataJson: Record<string, unknown>;
}): Promise<void> => {
  try {
    await prisma.billingOpsAuditLog.create({
      data: {
        userId: args.userId,
        action: args.action,
        targetType: args.targetType,
        targetId: args.targetId,
        metadataJson: args.metadataJson as any,
      },
    });
  } catch (error) {
    // Audit persistence should not block core operations.
    app.log.warn({ error, action: args.action }, 'failed to persist billing ops audit log');
  }
};

const applyAdminShopPlan = async (args: { shopId: string; plan: 'standard' | 'unlimited' }): Promise<void> => {
  const now = new Date();

  if (args.plan === 'unlimited') {
    const farFuture = new Date(Date.UTC(2099, 11, 31, 23, 59, 59, 999));

    await prisma.shopSubscription.upsert({
      where: { shopId: args.shopId },
      update: {
        status: 'unlimited',
        basePriceMinor: 0,
        includedUnitsPerMonth: 2147483647,
        overageUnitMinor: 0,
        currentPeriodStart: now,
        currentPeriodEnd: farFuture,
      },
      create: {
        shopId: args.shopId,
        status: 'unlimited',
        basePriceMinor: 0,
        includedUnitsPerMonth: 2147483647,
        overageUnitMinor: 0,
        currentPeriodStart: now,
        currentPeriodEnd: farFuture,
      },
    });
    return;
  }

  const trialPolicy = await getTrialPolicy();
  const trialEndsAt = new Date(now.getTime() + trialPolicy.trialDays * 24 * 60 * 60 * 1000);
  const defaultPeriodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));

  await prisma.shopSubscription.upsert({
    where: { shopId: args.shopId },
    update: {
      status: trialPolicy.enabled ? 'trialing' : 'incomplete',
      basePriceMinor: 99900,
      includedUnitsPerMonth: 100,
      overageUnitMinor: 50,
      currentPeriodStart: now,
      currentPeriodEnd: trialPolicy.enabled ? trialEndsAt : defaultPeriodEnd,
    },
    create: {
      shopId: args.shopId,
      status: trialPolicy.enabled ? 'trialing' : 'incomplete',
      basePriceMinor: 99900,
      includedUnitsPerMonth: 100,
      overageUnitMinor: 50,
      currentPeriodStart: now,
      currentPeriodEnd: trialPolicy.enabled ? trialEndsAt : defaultPeriodEnd,
    },
  });
};

const extractJsonObjectText = (rawText: string): string | null => {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const candidate = fenced[1].trim();
    if (candidate.startsWith('{') && candidate.endsWith('}')) {
      return candidate;
    }
  }

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) {
    return trimmed.slice(first, last + 1);
  }

  return null;
};

const allowedOrigins: string[] | true = (() => {
  const origins: string[] = [];
  if (env.CORS_ORIGINS) origins.push(...env.CORS_ORIGINS.split(',').map(o => o.trim()).filter(Boolean));
  if (env.APP_BASE_URL && !origins.includes(env.APP_BASE_URL)) origins.push(env.APP_BASE_URL);
  return origins.length > 0 ? origins : true;
})();
await app.register(cors, { origin: allowedOrigins, credentials: true });
await app.register(helmet, { contentSecurityPolicy: false });
await app.register(rateLimit, { max: 200, timeWindow: '1 minute' });
await app.register(jwt, { secret: env.JWT_SECRET });
await app.register(rawBody, {
  field: 'rawBody',
  global: false,
  encoding: 'utf8',
  runFirst: true,
});

const withAuth = async (request: any, reply: any): Promise<boolean> => {
  try {
    await request.jwtVerify();

    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: {
        id: true,
        shopId: true,
        platformRole: true,
      },
    });

    if (!user) {
      reply.code(401).send({ error: 'Unauthorized' });
      return false;
    }

    const pathname = String(request.url ?? '/').split('?')[0];
    if (hasPlatformGlobalAccess(user.platformRole) || shouldBypassSubscriptionGate(pathname)) {
      return true;
    }

    if (!user.shopId) {
      // JWT has no shopId — try to auto-select the first shop in the user's org
      const membership = await prisma.organizationMembership.findFirst({
        where: { userId: user.id },
        include: { organization: { include: { shops: { take: 1, orderBy: { createdAt: 'asc' } } } } },
        orderBy: { createdAt: 'asc' },
      });
      const autoShop = membership?.organization?.shops?.[0];
      if (!autoShop) {
        reply.code(402).send({ error: 'No active shop selected', code: 'SHOP_REQUIRED' });
        return false;
      }
      // Persist so route handlers (getCurrentUser) see it immediately
      await prisma.user.update({ where: { id: user.id }, data: { shopId: autoShop.id } });
      user.shopId = autoShop.id;
    }

    const subscription = await prisma.shopSubscription.findUnique({
      where: { shopId: user.shopId },
      select: {
        status: true,
        currentPeriodEnd: true,
      },
    });

    if (!isSubscriptionAccessAllowed(subscription)) {
      reply.code(402).send({
        error: 'Active subscription required for this shop',
        code: 'SUBSCRIPTION_REQUIRED',
        shopId: user.shopId,
      });
      return false;
    }

    return true;
  } catch {
    reply.code(401).send({ error: 'Unauthorized' });
    return false;
  }
};

const activeShopSelectionSchema = z.object({
  shopId: z.string().cuid(),
});

const hasPlatformGlobalAccess = (platformRole: string | null | undefined): boolean =>
  platformRole === 'platform_admin' || platformRole === 'platform_support';

const getCurrentUser = async (request: any): Promise<any | null> => {
  const user = await prisma.user.findUnique({ where: { id: request.user.id } });
  if (!user) return null;
  // Honor X-EPIM-Shop-Id header so all handlers that read user.shopId get the correct active shop
  const headerShopId = getHeaderShopId(request);
  if (headerShopId) user.shopId = headerShopId;
  return user;
};

const getHeaderShopId = (request: any): string | null => {
  const value = request.headers['x-elpim-shop-id'];
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const resolveActiveShopId = (request: any, user: { shopId?: string | null }): string | null => getHeaderShopId(request) ?? user.shopId ?? null;

// For platform_admin users with no shopId header, fall back to first shop in system
const resolveShopIdForPlatformAdmin = async (request: any, user: any): Promise<string | null> => {
  const fromHeader = getHeaderShopId(request);
  if (fromHeader) return fromHeader;
  if (user.shopId) return user.shopId;
  if (!hasPlatformGlobalAccess(user.platformRole)) return null;
  const first = await prisma.shop.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } });
  return first?.id ?? null;
};

const ensureShopAccess = async (params: { user: any; shopId: string }): Promise<boolean> => {
  if (hasPlatformGlobalAccess(params.user?.platformRole)) {
    return true;
  }

  const accessible = await prisma.shop.findFirst({
    where: {
      id: params.shopId,
      OR: [
        { memberships: { some: { userId: params.user.id } } },
        { organization: { memberships: { some: { userId: params.user.id } } } },
      ],
    },
    select: { id: true },
  });

  if (accessible) return true;

  // Bureau access: user is admin/owner in an agency org with an active relation to the shop's org
  const bureauAccess = await prisma.shop.findFirst({
    where: {
      id: params.shopId,
      organization: {
        clientRelations: {
          some: {
            status: 'active',
            agencyOrg: {
              memberships: {
                some: {
                  userId: params.user.id,
                  role: { in: ['owner', 'admin'] },
                },
              },
            },
          },
        },
      },
    },
    select: { id: true },
  });

  return Boolean(bureauAccess);
};

const ensureOrgAccess = async (params: { user: any; orgId: string; minRole?: 'admin' | 'owner' }): Promise<boolean> => {
  if (hasPlatformGlobalAccess(params.user?.platformRole)) return true;
  const membership = await prisma.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId: params.orgId, userId: params.user.id } },
    select: { role: true },
  });
  if (!membership) return false;
  if (!params.minRole) return true;
  if (params.minRole === 'admin') return membership.role === 'owner' || membership.role === 'admin';
  return membership.role === 'owner';
};

type TrialPolicy = {
  enabled: boolean;
  trialDays: number;
};

const getTrialPolicy = async (): Promise<TrialPolicy> => {
  const row = await prisma.platformSetting.findUnique({ where: { key: 'billing_trial_policy' } });
  const raw = (row?.valueJson ?? {}) as Record<string, unknown>;

  const enabled = raw.enabled === undefined ? true : Boolean(raw.enabled);
  const trialDaysRaw = Number(raw.trialDays ?? 14);
  const trialDays = Number.isFinite(trialDaysRaw) ? Math.min(60, Math.max(1, Math.trunc(trialDaysRaw))) : 14;

  return { enabled, trialDays };
};

/** Retrieve the platform-wide OpenAI API key (stored encrypted in PlatformSetting). */
const getPlatformOpenAiKey = async (): Promise<string | null> => {
  const row = await prisma.platformSetting.findUnique({ where: { key: 'openai_api_key' } });
  if (!row?.valueJson) return null;
  const raw = row.valueJson as Record<string, unknown>;
  const encrypted = typeof raw.encryptedKey === 'string' ? raw.encryptedKey : null;
  if (!encrypted) return null;
  return decryptSecret(encrypted, env.MASTER_ENCRYPTION_KEY);
};

const isSubscriptionAccessAllowed = (subscription: {
  status: string;
  currentPeriodEnd: Date;
} | null): boolean => {
  if (!subscription) {
    return false;
  }

  if (subscription.status === 'active') {
    return true;
  }

  if (subscription.status === 'unlimited') {
    return true;
  }

  if (subscription.status === 'trialing') {
    return subscription.currentPeriodEnd.getTime() >= Date.now();
  }

  return false;
};

const shouldBypassSubscriptionGate = (pathname: string): boolean => {
  const bypassPrefixes = [
    '/health',
    '/metrics',
    '/auth/',
    '/shops/current',
    '/shops/connect',
    '/tenancy/context',
    '/platform/banner',
    '/integrations/openai',
    '/shops/',
    '/billing/',
    '/admin/',
    '/organizations/',
    '/agency/',
    '/webhooks/',
  ];

  if (pathname.startsWith('/shops/')) {
    // Allow subscription management endpoints when user is not yet subscribed.
    return pathname.includes('/subscription') || pathname.endsWith('/current') || pathname.endsWith('/connect');
  }

  if (pathname.startsWith('/billing/')) {
    return true;
  }

  return bypassPrefixes.some((prefix) => pathname.startsWith(prefix));
};

const promptTemplateSchema = z.object({
  name: z.string().min(1),
  body: z.string().min(1),
  category: z.string().default('Ukategoriseret'),
  targetType: z.string().default('product'),
  tagsJson: z.array(z.string()).default([]),
  isDefault: z.boolean().optional().default(false),
});

const sourceTypeSchema = z.enum(['web', 'products', 'product_feed', 'live_lookup']);
const sourceFeedTypeSchema = z.enum(['live_url', 'static_file']);
const sourceScopeSchema = z.enum(['products']);
const sourceCrawlFrequencySchema = z.enum(['daily', 'every_3_days', 'weekly']);

const sourceCreateSchema = z.object({
  name: z.string().min(1),
  type: sourceTypeSchema.default('product_feed'),
  feedType: sourceFeedTypeSchema.optional(),
  scope: sourceScopeSchema.default('products'),
  crawlFrequency: sourceCrawlFrequencySchema.optional(),
  promptTemplate: z.string().trim().optional(),
  url: z.string().trim().optional(),
  tagsJson: z.array(z.string()).default([]),
  active: z.boolean().optional().default(true),
  fileName: z.string().trim().optional(),
  csv: z.string().optional(),
});

const sourcePatchSchema = z.object({
  name: z.string().min(1).optional(),
  type: sourceTypeSchema.optional(),
  feedType: sourceFeedTypeSchema.optional(),
  scope: sourceScopeSchema.optional(),
  crawlFrequency: sourceCrawlFrequencySchema.optional(),
  promptTemplate: z.string().trim().optional(),
  url: z.string().trim().optional(),
  tagsJson: z.array(z.string()).optional(),
  active: z.boolean().optional(),
  fileName: z.string().trim().optional(),
  csv: z.string().optional(),
});

const sourceApplyProductsSchema = z.object({
  syncNow: z.boolean().optional().default(true),
});

const setupSubscriptionSchema = z.object({
  status: z.enum(['trialing', 'active', 'unlimited', 'past_due', 'canceled', 'incomplete']).optional().default('active'),
  currentPeriodStart: z.string().datetime().optional(),
  currentPeriodEnd: z.string().datetime().optional(),
  basePriceMinor: z.number().int().min(0).optional().default(99900),
  includedUnitsPerMonth: z.number().int().min(0).optional().default(100),
  overageUnitMinor: z.number().int().min(0).optional().default(50),
});

const adminCreateShopSchema = z.object({
  shopUrl: z.string().url(),
  organizationId: z.string().cuid().optional(),
  organizationName: z.string().min(1).optional(),
  ownerUserId: z.string().cuid().optional(),
  subscriptionPlan: z.enum(['standard', 'unlimited']).optional().default('standard'),
});

const adminShopPlanSchema = z.object({
  plan: z.enum(['standard', 'unlimited']),
});

const billingCloseSchema = z.object({
  monthKey: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  finalize: z.boolean().optional().default(false),
});

const retryWebhookEventSchema = z.object({
  force: z.boolean().optional().default(false),
});

const resendNoticeSchema = z.object({
  shopId: z.string().cuid(),
  monthKey: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  kind: z.enum(['included_reached_100', 'overage_started']),
});

const platformTrialPolicySchema = z.object({
  enabled: z.boolean(),
  trialDays: z.number().int().min(1).max(60).default(14),
});

// ── Admin management schemas ──────────────────────────────────────────────────

const adminCreateUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  firstName: z.string().trim().optional(),
  lastName: z.string().trim().optional(),
  title: z.string().trim().optional(),
  platformRole: z.enum(['none', 'platform_admin', 'platform_support']).default('none'),
});

const adminPatchUserSchema = z.object({
  email: z.string().email().optional(),
  firstName: z.string().trim().nullable().optional(),
  lastName: z.string().trim().nullable().optional(),
  title: z.string().trim().nullable().optional(),
  platformRole: z.enum(['none', 'platform_admin', 'platform_support']).optional(),
  password: z.string().min(8).optional(),
  sendPasswordNotification: z.boolean().optional(),
});

const adminUserOrgMembershipSchema = z.object({
  organizationId: z.string().cuid(),
  role: z.enum(['owner', 'admin', 'member']).default('member'),
});

const adminCreateOrgSchema = z.object({
  cvrNumber: z.string().trim().regex(/^\d{8}$/, 'CVR-nummer skal bestå af 8 cifre'),
  name: z.string().trim().min(1).optional(),
  address: z.string().trim().optional(),
  type: z.enum(['regular', 'agency']).default('regular'),
});

const adminPatchOrgSchema = z.object({
  name: z.string().trim().min(1).optional(),
  cvrNumber: z.string().trim().length(8).regex(/^\d{8}$/).nullable().optional(),
  type: z.enum(['regular', 'agency']).optional(),
  address: z.string().trim().nullable().optional(),
});

const orgMemberSchema = z.object({
  userId: z.string().cuid(),
  role: z.enum(['owner', 'admin', 'member']).default('member'),
});

const orgMemberPatchSchema = z.object({
  role: z.enum(['owner', 'admin', 'member']),
});

const shopAccessGrantSchema = z.object({
  userId: z.string().cuid(),
});

const agencyRelationCreateSchema = z.object({
  clientOrgId: z.string().cuid(),
  commissionRateBps: z.number().int().min(0).max(10000).default(2000),
});

const agencyRelationPatchSchema = z.object({
  commissionRateBps: z.number().int().min(0).max(10000).optional(),
  status: z.enum(['active', 'paused', 'terminated']).optional(),
});

const payoutRequestCreateSchema = z.object({
  agencyOrgId: z.string().cuid(),
  periodFrom: z.string().datetime(),
  periodTo: z.string().datetime(),
});

const payoutStatusSchema = z.object({
  status: z.enum(['approved', 'rejected', 'paid']),
  adminNote: z.string().optional(),
});

// ── CVR lookup ────────────────────────────────────────────────────────────────

type CvrData = { name: string; address: string };

const lookupCvr = async (cvrNumber: string): Promise<CvrData | null> => {
  try {
    const response = await fetch(`https://cvrapi.dk/api?country=DK&vat=${encodeURIComponent(cvrNumber)}`, {
      headers: { 'User-Agent': 'EL-PIM/1.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as Record<string, unknown>;
    if (typeof (data as any).error !== 'undefined') return null;
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (!name) return null;
    const parts = [
      typeof data.address === 'string' ? data.address.trim() : '',
      typeof data.zipcode === 'string' ? data.zipcode.trim() : '',
      typeof data.city === 'string' ? data.city.trim() : '',
    ].filter(Boolean);
    return { name, address: parts.join(', ') };
  } catch {
    return null;
  }
};

const generateReferralCode = (): string => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
};

type SourceType = z.infer<typeof sourceTypeSchema>;
type SourceFeedType = z.infer<typeof sourceFeedTypeSchema>;
type SourceScope = z.infer<typeof sourceScopeSchema>;
type SourceCrawlFrequency = z.infer<typeof sourceCrawlFrequencySchema>;

type SourceFieldMapping = {
  csvColumn: string;
  fieldDefinitionId: string;
};

type CrawlResult = {
  totalRows: number;
  matchedRows: number;
  unmatchedRows: number;
  upsertedRows: number;
  deletedStaleRows: number;
  durationMs: number;
};

type SourceMeta = {
  type: SourceType;
  feedType?: SourceFeedType;
  scope?: SourceScope;
  crawlFrequency?: SourceCrawlFrequency;
  promptTemplate?: string;
  tags: string[];
  fileName?: string;
  csv?: string;
  lastScanAt?: string;
  lastCrawlAt?: string;
  lastCrawlResult?: CrawlResult;
  crawlStatus?: 'idle' | 'crawling' | 'failed';
  crawlError?: string;
  crawlStartedAt?: string;
  fieldMappings?: SourceFieldMapping[];
};

const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
};

const readSourceMeta = (tagsJson: unknown): SourceMeta => {
  if (Array.isArray(tagsJson)) {
    return { type: 'web', tags: asStringArray(tagsJson) };
  }

  if (tagsJson && typeof tagsJson === 'object') {
    const raw = tagsJson as Record<string, unknown>;
    const type = sourceTypeSchema.safeParse(raw.type).success
      ? (raw.type as SourceType)
      : raw.csv && typeof raw.csv === 'string'
        ? 'products'
        : 'web';

    const fieldMappings: SourceFieldMapping[] = Array.isArray(raw.fieldMappings)
      ? raw.fieldMappings.filter(
          (m): m is SourceFieldMapping =>
            typeof m === 'object' &&
            m !== null &&
            typeof (m as SourceFieldMapping).csvColumn === 'string' &&
            typeof (m as SourceFieldMapping).fieldDefinitionId === 'string',
        )
      : [];

    return {
      type,
      feedType: typeof raw.feedType === 'string' ? (raw.feedType as SourceFeedType) : (type === 'products' || type === 'product_feed' && raw.csv ? 'static_file' : type === 'web' ? 'live_url' : undefined),
      scope: typeof raw.scope === 'string' ? (raw.scope as SourceScope) : 'products',
      crawlFrequency: typeof raw.crawlFrequency === 'string' ? (raw.crawlFrequency as SourceCrawlFrequency) : undefined,
      promptTemplate: typeof raw.promptTemplate === 'string' ? raw.promptTemplate : undefined,
      tags: asStringArray(raw.tags),
      fileName: typeof raw.fileName === 'string' && raw.fileName.trim().length > 0 ? raw.fileName.trim() : undefined,
      csv: typeof raw.csv === 'string' ? raw.csv : undefined,
      lastScanAt: typeof raw.lastScanAt === 'string' ? raw.lastScanAt : undefined,
      lastCrawlAt: typeof raw.lastCrawlAt === 'string' ? raw.lastCrawlAt : undefined,
      lastCrawlResult: raw.lastCrawlResult && typeof raw.lastCrawlResult === 'object' ? raw.lastCrawlResult as CrawlResult : undefined,
      crawlStatus: raw.crawlStatus === 'crawling' || raw.crawlStatus === 'failed' ? raw.crawlStatus : 'idle',
      crawlError: typeof raw.crawlError === 'string' ? raw.crawlError : undefined,
      crawlStartedAt: typeof raw.crawlStartedAt === 'string' ? raw.crawlStartedAt : undefined,
      ...(fieldMappings.length > 0 ? { fieldMappings } : {}),
    };
  }

  return { type: 'web', tags: [] };
};

const buildSourceTagsJson = (meta: SourceMeta): unknown =>
  ({
    type: meta.type,
    feedType: meta.feedType,
    scope: meta.scope,
    crawlFrequency: meta.crawlFrequency,
    promptTemplate: meta.promptTemplate,
    tags: meta.tags,
    ...(meta.fileName ? { fileName: meta.fileName } : {}),
    ...(meta.csv ? { csv: meta.csv } : {}),
    ...(meta.lastScanAt ? { lastScanAt: meta.lastScanAt } : {}),
    ...(meta.lastCrawlAt ? { lastCrawlAt: meta.lastCrawlAt } : {}),
    ...(meta.lastCrawlResult ? { lastCrawlResult: meta.lastCrawlResult } : {}),
    ...(meta.crawlStatus ? { crawlStatus: meta.crawlStatus } : {}),
    ...(meta.crawlError ? { crawlError: meta.crawlError } : {}),
    ...(meta.crawlStartedAt ? { crawlStartedAt: meta.crawlStartedAt } : {}),
    ...(meta.fieldMappings?.length ? { fieldMappings: meta.fieldMappings } : {}),
  }) as any;

const normalizeSourceDto = <T extends { tagsJson: unknown; url: string }>(source: T): T & {
  type: SourceType;
  feedType?: SourceFeedType;
  scope?: SourceScope;
  crawlFrequency?: SourceCrawlFrequency;
  promptTemplate?: string;
  fileName?: string;
  hasFile: boolean;
  tagsJson: string[];
  urlTemplate?: string;
  lastCrawlAt?: string;
  lastCrawlResult?: CrawlResult;
  crawlStatus?: 'idle' | 'crawling' | 'failed';
  crawlError?: string;
  crawlStartedAt?: string;
  fieldMappings: SourceFieldMapping[];
} => {
  const meta = readSourceMeta(source.tagsJson);
  return {
    ...source,
    type: meta.type,
    feedType: meta.feedType,
    scope: meta.scope ?? 'products',
    crawlFrequency: meta.crawlFrequency,
    promptTemplate: meta.promptTemplate,
    fileName: meta.fileName,
    hasFile: Boolean(meta.csv),
    tagsJson: meta.tags,
    ...(meta.type === 'live_lookup' ? { urlTemplate: source.url } : {}),
    lastCrawlAt: meta.lastCrawlAt,
    lastCrawlResult: meta.lastCrawlResult,
    crawlStatus: meta.crawlStatus ?? 'idle',
    crawlError: meta.crawlError,
    crawlStartedAt: meta.crawlStartedAt,
    fieldMappings: meta.fieldMappings ?? [],
  };
};

const normalizeHeader = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, '').replace(/[-_]/g, '');

const parseCsvHeaders = (csv: string): string[] => {
  const firstLine = csv.split('\n').map((l) => l.replace(/\r/g, '')).find((l) => l.trim().length > 0) ?? '';
  if (!firstLine) return [];
  const commaCount = (firstLine.match(/,/g) ?? []).length;
  const semicolonCount = (firstLine.match(/;/g) ?? []).length;
  const delimiter = semicolonCount > commaCount ? ';' : ',';
  return firstLine.split(delimiter).map((h) => normalizeHeader(cleanCsvCell(h))).filter(Boolean);
};

const cleanCsvCell = (value: string): string => {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
};

const parseCsvRows = (csv: string): Array<Record<string, string>> => {
  const lines = csv
    .split('\n')
    .map((line) => line.replace(/\r/g, ''))
    .filter((line) => line.trim().length > 0);

  if (!lines.length) {
    return [];
  }

  const headerLine = lines[0] ?? '';
  const commaCount = (headerLine.match(/,/g) ?? []).length;
  const semicolonCount = (headerLine.match(/;/g) ?? []).length;
  const delimiter = semicolonCount > commaCount ? ';' : ',';

  const headers = headerLine.split(delimiter).map((header) => normalizeHeader(cleanCsvCell(header)));
  const rows: Array<Record<string, string>> = [];

  for (const line of lines.slice(1)) {
    const cells = line.split(delimiter).map((cell) => cleanCsvCell(cell));
    const row: Record<string, string> = {};
    for (let index = 0; index < headers.length; index += 1) {
      const header = headers[index];
      if (!header) {
        continue;
      }
      row[header] = cells[index] ?? '';
    }
    rows.push(row);
  }

  return rows;
};

const pickFirstCell = (row: Record<string, string>, keys: string[]): string => {
  for (const key of keys) {
    const value = row[normalizeHeader(key)];
    if (value && value.trim().length > 0) {
      return value.trim();
    }
  }
  return '';
};

type SourceRowValues = {
  productId?: string;
  handle?: string;
  sku?: string;
  title?: string;
  vendor?: string;
};

type ProductMatchBy = 'productId' | 'handle' | 'sku' | 'title+vendor';

type SourceProductScanMatch<TProduct> = {
  row: number;
  matchBy: ProductMatchBy;
  productId: string;
  productTitle: string;
  rowValues: SourceRowValues;
  rowData: Record<string, string>;
  product: TProduct;
};

type SourceProductScanUnmatched = {
  row: number;
  rowValues: SourceRowValues;
};

const buildSourceRowValues = (row: Record<string, string>): SourceRowValues => ({
  productId: pickFirstCell(row, ['productid', 'id', 'epimproductid']),
  handle: pickFirstCell(row, ['handle', 'producthandle']),
  sku: pickFirstCell(row, ['sku', 'variantsku', 'itemno', 'itemnumber']),
  title: pickFirstCell(row, ['title', 'name', 'producttitle', 'produktnavn']),
  vendor: pickFirstCell(row, ['vendor', 'supplier', 'brand', 'leverandor', 'leverandør']),
});

const buildSourceProductScan = <TProduct extends {
  id: string;
  title: string;
  handle: string;
  vendor?: string | null;
  productType?: string | null;
  status?: string | null;
  descriptionHtml?: string | null;
  tagsJson?: unknown;
  variants: Array<{ sku?: string | null }>;
}>(
  csv: string,
  products: TProduct[],
): {
  headers: string[];
  totalRows: number;
  matches: Array<SourceProductScanMatch<TProduct>>;
  unmatched: SourceProductScanUnmatched[];
} => {
  const headers = parseCsvHeaders(csv);
  const rows = parseCsvRows(csv);
  const byId = new Map(products.map((product) => [product.id, product]));
  const byHandle = new Map(products.map((product) => [product.handle.toLowerCase(), product]));
  const bySku = new Map<string, TProduct>();

  for (const product of products) {
    for (const variant of product.variants) {
      const sku = variant.sku?.trim().toLowerCase();
      if (sku) {
        bySku.set(sku, product);
      }
    }
  }

  const matches: Array<SourceProductScanMatch<TProduct>> = [];
  const unmatched: SourceProductScanUnmatched[] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] ?? {};
    const rowValues = buildSourceRowValues(row);

    const byProductId = rowValues.productId ? byId.get(rowValues.productId) : undefined;
    if (byProductId) {
      matches.push({
        row: index + 2,
        matchBy: 'productId',
        productId: byProductId.id,
        productTitle: byProductId.title,
        rowValues,
        rowData: row,
        product: byProductId,
      });
      continue;
    }

    const byProductHandle = rowValues.handle ? byHandle.get(rowValues.handle.toLowerCase()) : undefined;
    if (byProductHandle) {
      matches.push({
        row: index + 2,
        matchBy: 'handle',
        productId: byProductHandle.id,
        productTitle: byProductHandle.title,
        rowValues,
        rowData: row,
        product: byProductHandle,
      });
      continue;
    }

    const byProductSku = rowValues.sku ? bySku.get(rowValues.sku.toLowerCase()) : undefined;
    if (byProductSku) {
      matches.push({
        row: index + 2,
        matchBy: 'sku',
        productId: byProductSku.id,
        productTitle: byProductSku.title,
        rowValues,
        rowData: row,
        product: byProductSku,
      });
      continue;
    }

    const byTitleVendor = products.find((product) => {
      const titleMatches = rowValues.title && product.title.toLowerCase() === rowValues.title.toLowerCase();
      const vendorMatches = rowValues.vendor && (product.vendor ?? '').toLowerCase() === rowValues.vendor.toLowerCase();
      return Boolean(titleMatches && vendorMatches);
    });

    if (byTitleVendor) {
      matches.push({
        row: index + 2,
        matchBy: 'title+vendor',
        productId: byTitleVendor.id,
        productTitle: byTitleVendor.title,
        rowValues,
        rowData: row,
        product: byTitleVendor,
      });
      continue;
    }

    unmatched.push({
      row: index + 2,
      rowValues,
    });
  }

  return { headers, totalRows: rows.length, matches, unmatched };
};

const shopSettingSchema = z.object({
  key: z.string().min(1),
  valueJson: z.any(),
});

const deleteFieldSchema = z.object({
  confirm: z.literal(true),
  confirmText: z.string().min(1),
});

/**
 * Ensure the two built-in fields (Titel, Beskrivelse) exist for a shop.
 * Called on shop connect and also lazily when fetching fields.
 */
const ensureBuiltInFields = async (shopId: string): Promise<void> => {
  const builtIns: Array<{
    key: string;
    label: string;
    type: 'text' | 'html';
  }> = [
    { key: '_title', label: 'Titel', type: 'text' },
    { key: '_description', label: 'Beskrivelse', type: 'html' },
    { key: '_meta_title', label: 'Metatitel', type: 'text' },
    { key: '_meta_description', label: 'Metabeskrivelse', type: 'text' },
  ];

  for (const def of builtIns) {
    await prisma.fieldDefinition.upsert({
      where: { shopId_key: { shopId, key: def.key } },
      update: { isBuiltIn: true },
      create: {
        shopId,
        key: def.key,
        label: def.label,
        scope: 'product',
        type: def.type,
        isBuiltIn: true,
        constraintsJson: {},
        uiConfigJson: {},
      },
    });
  }

  // Collection built-ins
  const collectionBuiltIns: Array<{ key: string; label: string; type: 'text' | 'html' }> = [
    { key: '_col_title', label: 'Titel', type: 'text' },
    { key: '_col_description', label: 'Beskrivelse', type: 'html' },
  ];
  for (const def of collectionBuiltIns) {
    await prisma.fieldDefinition.upsert({
      where: { shopId_key: { shopId, key: def.key } },
      update: { isBuiltIn: true },
      create: {
        shopId,
        key: def.key,
        label: def.label,
        scope: 'collection',
        type: def.type,
        isBuiltIn: true,
        constraintsJson: {},
        uiConfigJson: {},
      },
    });
  }
};

app.get('/health', async () => ({ status: 'ok', service: 'api' }));

app.get('/metrics', async () => {
  const [totalJobs, failedJobs, queuedJobs] = await Promise.all([
    prisma.syncJob.count(),
    prisma.syncJob.count({ where: { status: 'failed', dismissed: false } }),
    prisma.syncJob.count({ where: { status: 'queued' } }),
  ]);

  return {
    jobs_total: totalJobs,
    jobs_failed: failedJobs,
    jobs_queued: queuedJobs,
  };
});

app.post('/auth/register', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request: any, reply: any) => {
  const parsed = registerSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }

  // If email already registered, send a login magic link instead of creating a duplicate
  const existing = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (existing) {
    const baseUrl = (request.headers.origin as string | undefined) ?? env.APP_BASE_URL ?? '';
    try {
      await sendMagicLink({ userId: existing.id, email: existing.email, redirectTo: '/dashboard/products', baseUrl });
    } catch { /* swallow — don't leak email existence */ }
    return reply.code(200).send({ sent: true });
  }

  // Check for a pending invitation for this email before creating an org
  const pendingInvitation = await prisma.organizationInvitation.findFirst({
    where: { invitedEmail: parsed.data.email, acceptedAt: null, expiresAt: { gt: new Date() } },
    include: { organization: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'desc' },
  });

  const baseUrl = (request.headers.origin as string | undefined) ?? env.APP_BASE_URL ?? '';

  if (pendingInvitation) {
    // Invited user — create account without a separate org; the invitation provides org membership
    const invitedUser = await prisma.user.create({
      data: {
        email: parsed.data.email,
        firstName: parsed.data.firstName,
        lastName: parsed.data.lastName,
        phone: parsed.data.phone ?? null,
        referralSource: parsed.data.referralSource ?? null,
        role: 'member',
      },
    });

    await prisma.organizationMembership.create({
      data: { organizationId: pendingInvitation.organizationId, userId: invitedUser.id, role: pendingInvitation.role },
    });

    await prisma.organizationInvitation.update({
      where: { id: pendingInvitation.id },
      data: { acceptedAt: new Date() },
    });

    try {
      await sendMagicLink({ userId: invitedUser.id, email: invitedUser.email, redirectTo: '/dashboard/products', baseUrl });
    } catch (err) {
      request.log.error({ err, userId: invitedUser.id }, 'failed to send magic link for invited user');
      return reply.code(500).send({ error: 'Din konto er oprettet, men vi kunne ikke sende login-linket. Kontakt support.' });
    }

    return reply.code(201).send({ sent: true });
  }

  const user = await prisma.user.create({
    data: {
      email: parsed.data.email,
      firstName: parsed.data.firstName,
      lastName: parsed.data.lastName,
      phone: parsed.data.phone ?? null,
      referralSource: parsed.data.referralSource ?? null,
      role: 'owner',
    },
  });

  const orgName = parsed.data.companyName?.trim() || `${parsed.data.email.split('@')[0] ?? 'New'} Organization`;
  const defaultOrganization = await prisma.organization.create({
    data: { name: orgName },
  });

  await prisma.organizationMembership.create({
    data: { organizationId: defaultOrganization.id, userId: user.id, role: 'owner' },
  });

  try {
    await sendMagicLink({ userId: user.id, email: user.email, redirectTo: '/onboarding', baseUrl });
  } catch (err) {
    request.log.error({ err, userId: user.id }, 'failed to send registration magic link');
    return reply.code(500).send({ error: 'Din konto er oprettet, men vi kunne ikke sende login-linket. Kontakt support.' });
  }

  return reply.code(201).send({ sent: true });
});

app.post('/auth/passcode', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request: any, reply: any) => {
  const { code } = (request.body ?? {}) as { code?: string };
  if (!code || code !== env.ACCESS_CODE) {
    return reply.code(401).send({ error: 'Forkert adgangskode.' });
  }

  let user = await prisma.user.findFirst({
    where: { platformRole: 'platform_admin' },
    orderBy: { createdAt: 'asc' },
  });

  if (!user) {
    user = await prisma.user.create({
      data: {
        email: 'admin@elpim.local',
        passwordHash: await hashPassword(env.ACCESS_CODE),
        role: 'owner',
        platformRole: 'platform_admin',
      },
    });
  }

  const token = app.jwt.sign(
    { id: user.id, email: user.email, role: user.role, shopId: user.shopId, platformRole: user.platformRole },
    { expiresIn: '365d' },
  );

  return { token, redirectTo: '/dashboard/products' };
});

app.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request: any, reply: any) => {
  const parsed = loginSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });

  // Always return { sent: true } to avoid leaking whether the email exists
  if (user) {
    const baseUrl = (request.headers.origin as string | undefined) ?? env.APP_BASE_URL ?? '';
    try {
      await sendMagicLink({ userId: user.id, email: user.email, redirectTo: '/dashboard/products', baseUrl });
    } catch { /* swallow email errors in login */ }
  }

  return { sent: true };
});

// GET /auth/magic-link/verify — validates a magic link token and returns a JWT
app.get('/auth/magic-link/verify', { config: { rateLimit: { max: 30, timeWindow: '5 minutes' } } }, async (request: any, reply: any) => {
  const { token } = (request.query ?? {}) as { token?: string };
  if (!token) return reply.code(400).send({ error: 'Token mangler' });

  const record = await prisma.magicLinkToken.findUnique({ where: { token }, include: { user: true } });

  if (!record) return reply.code(400).send({ error: 'Ugyldigt link' });
  if (record.usedAt) return reply.code(400).send({ error: 'Dette link er allerede brugt. Anmod om et nyt.' });
  if (record.expiresAt < new Date()) return reply.code(400).send({ error: 'Linket er udløbet. Anmod om et nyt.' });

  await prisma.magicLinkToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });

  // Mark email as verified on first use
  if (!record.user.emailVerifiedAt) {
    await prisma.user.update({ where: { id: record.userId }, data: { emailVerifiedAt: new Date() } });
  }

  const jwt = app.jwt.sign(
    { id: record.user.id, email: record.user.email, role: record.user.role, shopId: record.user.shopId, platformRole: record.user.platformRole },
    { expiresIn: '30d' },
  );

  return { token: jwt, redirectTo: record.redirectTo ?? '/dashboard/products' };
});


app.get('/me', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }
  const user = await getCurrentUser(request);
  const platformOpenAiConfigured = user ? Boolean(await getPlatformOpenAiKey()) : false;

  return {
    user: user
      ? {
          ...user,
          hasOpenAiKey: platformOpenAiConfigured,
          encryptedOpenAiKey: undefined,
        }
      : null,
  };
});

app.get('/admin/platform-settings', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }

  if (!hasPlatformGlobalAccess(user.platformRole)) {
    return reply.code(403).send({ error: 'Platform admin/support role required' });
  }

  const trialPolicy = await getTrialPolicy();
  return { billingTrialPolicy: trialPolicy };
});

app.put('/admin/platform-settings', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const parsed = z.object({ billingTrialPolicy: platformTrialPolicySchema }).safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }

  if (!hasPlatformGlobalAccess(user.platformRole)) {
    return reply.code(403).send({ error: 'Platform admin/support role required' });
  }

  await prisma.platformSetting.upsert({
    where: { key: 'billing_trial_policy' },
    update: {
      valueJson: parsed.data.billingTrialPolicy as any,
    },
    create: {
      key: 'billing_trial_policy',
      valueJson: parsed.data.billingTrialPolicy as any,
    },
  });

  await createBillingOpsAudit({
    userId: user.id,
    action: 'platform_trial_policy_update',
    targetType: 'platform_setting',
    targetId: 'billing_trial_policy',
    metadataJson: parsed.data.billingTrialPolicy,
  });

  return { ok: true, billingTrialPolicy: parsed.data.billingTrialPolicy };
});

app.post('/admin/shops', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const parsed = adminCreateShopSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }

  if (!hasPlatformGlobalAccess(user.platformRole)) {
    return reply.code(403).send({ error: 'Platform admin/support role required' });
  }

  const ownerUserId = parsed.data.ownerUserId ?? user.id;
  const owner = await prisma.user.findUnique({ where: { id: ownerUserId } });
  if (!owner) {
    return reply.code(404).send({ error: 'Owner user not found' });
  }

  const existingShop = await prisma.shop.findUnique({ where: { shopUrl: parsed.data.shopUrl } });
  if (existingShop) {
    return reply.code(409).send({ error: 'Shop URL already exists' });
  }

  let org;
  if (parsed.data.organizationId) {
    org = await prisma.organization.findUnique({ where: { id: parsed.data.organizationId } });
    if (!org) {
      return reply.code(404).send({ error: 'Organization not found' });
    }
  } else {
    org = await prisma.organization.create({
      data: {
        name: parsed.data.organizationName?.trim() || `${parsed.data.shopUrl.replace(/^https?:\/\//, '')} Organization`,
      },
    });
  }

  await prisma.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: org.id, userId: owner.id } },
    update: {},
    create: {
      organizationId: org.id,
      userId: owner.id,
      role: 'owner',
    },
  });

  const shop = await prisma.shop.create({
    data: {
      shopUrl: parsed.data.shopUrl,
      organizationId: org.id,
      status: 'disconnected',
      encryptedAdminToken: encryptSecret('UNMANAGED_NO_TOKEN', env.MASTER_ENCRYPTION_KEY),
    },
  });

  await prisma.shopMembership.upsert({
    where: {
      shopId_userId: {
        shopId: shop.id,
        userId: owner.id,
      },
    },
    update: { role: 'member' },
    create: {
      shopId: shop.id,
      userId: owner.id,
      role: 'member',
    },
  });

  await prisma.user.update({ where: { id: owner.id }, data: { shopId: shop.id } });

  await applyAdminShopPlan({ shopId: shop.id, plan: parsed.data.subscriptionPlan });

  await createBillingOpsAudit({
    userId: user.id,
    action: 'admin_shop_create',
    targetType: 'shop',
    targetId: shop.id,
    metadataJson: {
      ownerUserId: owner.id,
      subscriptionPlan: parsed.data.subscriptionPlan,
      shopUrl: parsed.data.shopUrl,
    },
  });

  return { shop, ownerUserId: owner.id, subscriptionPlan: parsed.data.subscriptionPlan };
});

// Admin: AI usage grouped per user across all shops
app.get('/admin/usage-per-user', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }

  if (!hasPlatformGlobalAccess(user.platformRole)) {
    return reply.code(403).send({ error: 'Platform admin/support role required' });
  }

  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const shopIdFilter = typeof request.query.shopId === 'string' ? request.query.shopId : undefined;

  const usages = await prisma.aiUsage.groupBy({
    by: ['userId'],
    where: {
      ...(shopIdFilter ? { shopId: shopIdFilter } : {}),
    },
    _sum: { totalTokens: true, estimatedCostDkk: true, estimatedCostUsd: true },
    _count: { id: true },
    orderBy: { _sum: { estimatedCostDkk: 'desc' } },
  });

  const usages30d = await prisma.aiUsage.groupBy({
    by: ['userId'],
    where: {
      createdAt: { gte: since30d },
      ...(shopIdFilter ? { shopId: shopIdFilter } : {}),
    },
    _sum: { totalTokens: true, estimatedCostDkk: true },
    _count: { id: true },
  });

  const usage30dMap = new Map(usages30d.map((row) => [row.userId, row]));

  const userIds = usages.map((row) => row.userId).filter((id): id is string => id != null);
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, email: true, firstName: true, lastName: true },
  });
  const userMap = new Map(users.map((u) => [u.id, u]));

  const rows = usages.map((row) => {
    const u = row.userId ? userMap.get(row.userId) : null;
    const row30d = row.userId ? usage30dMap.get(row.userId) : null;
    return {
      userId: row.userId,
      email: u?.email ?? null,
      firstName: u?.firstName ?? null,
      lastName: u?.lastName ?? null,
      totalTokensAllTime: row._sum.totalTokens ?? 0,
      costDkkAllTime: row._sum.estimatedCostDkk ?? 0,
      costUsdAllTime: row._sum.estimatedCostUsd ?? 0,
      callsAllTime: row._count.id,
      totalTokens30d: row30d?._sum.totalTokens ?? 0,
      costDkk30d: row30d?._sum.estimatedCostDkk ?? 0,
      calls30d: row30d?._count.id ?? 0,
    };
  });

  return { rows, count: rows.length };
});

// Admin: per-day AI usage aggregation (last 60 days)
app.get('/admin/usage-daily', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid' });
  if (!hasPlatformGlobalAccess(user.platformRole)) return reply.code(403).send({ error: 'Platform admin/support role required' });

  const shopIdFilter = typeof request.query.shopId === 'string' && request.query.shopId ? request.query.shopId : undefined;
  const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);

  type DayRow = { day: Date; calls: bigint; total_tokens: bigint; cost_usd: number; cost_dkk: number };
  const rows: DayRow[] = shopIdFilter
    ? await prisma.$queryRaw<DayRow[]>`
        SELECT DATE_TRUNC('day', "createdAt" AT TIME ZONE 'UTC') AS day,
               COUNT(*)::bigint AS calls,
               SUM("totalTokens")::bigint AS total_tokens,
               SUM("estimatedCostUsd")::float AS cost_usd,
               SUM("estimatedCostDkk")::float AS cost_dkk
        FROM "AiUsage"
        WHERE "createdAt" >= ${since} AND "shopId" = ${shopIdFilter}
        GROUP BY 1 ORDER BY 1 DESC`
    : await prisma.$queryRaw<DayRow[]>`
        SELECT DATE_TRUNC('day', "createdAt" AT TIME ZONE 'UTC') AS day,
               COUNT(*)::bigint AS calls,
               SUM("totalTokens")::bigint AS total_tokens,
               SUM("estimatedCostUsd")::float AS cost_usd,
               SUM("estimatedCostDkk")::float AS cost_dkk
        FROM "AiUsage"
        WHERE "createdAt" >= ${since}
        GROUP BY 1 ORDER BY 1 DESC`;

  return reply.send({
    rows: rows.map((r) => ({
      day: r.day.toISOString().slice(0, 10),
      calls: Number(r.calls),
      totalTokens: Number(r.total_tokens),
      costUsd: r.cost_usd ?? 0,
      costDkk: r.cost_dkk ?? 0,
    })),
  });
});

// Admin: individual AI usage records with date range filter
app.get('/admin/usage-log', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid' });
  if (!hasPlatformGlobalAccess(user.platformRole)) return reply.code(403).send({ error: 'Platform admin/support role required' });

  const shopIdFilter = typeof request.query.shopId === 'string' && request.query.shopId ? request.query.shopId : undefined;
  const dateFilter = typeof request.query.date === 'string' && request.query.date ? request.query.date : undefined;
  const page = Math.max(1, parseInt(String(request.query.page ?? '1'), 10));
  const pageSize = 100;

  const startOfDay = dateFilter ? new Date(`${dateFilter}T00:00:00.000Z`) : undefined;
  const endOfDay = dateFilter ? new Date(`${dateFilter}T23:59:59.999Z`) : undefined;

  const where: Record<string, unknown> = {
    ...(shopIdFilter ? { shopId: shopIdFilter } : {}),
    ...(startOfDay && endOfDay ? { createdAt: { gte: startOfDay, lte: endOfDay } } : {}),
  };

  const [records, total] = await Promise.all([
    prisma.aiUsage.findMany({
      where: where as any,
      orderBy: { createdAt: 'desc' },
      take: pageSize,
      skip: (page - 1) * pageSize,
      include: {
        user: { select: { email: true, firstName: true, lastName: true } },
        product: { select: { title: true, handle: true } },
      },
    }),
    prisma.aiUsage.count({ where: where as any }),
  ]);

  return reply.send({
    records: records.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      shopId: r.shopId,
      feature: r.feature,
      model: r.model,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      totalTokens: r.totalTokens,
      costUsd: r.estimatedCostUsd,
      costDkk: r.estimatedCostDkk,
      userEmail: r.user?.email ?? null,
      userName: r.user ? `${r.user.firstName ?? ''} ${r.user.lastName ?? ''}`.trim() || null : null,
      productTitle: r.product?.title ?? null,
      productHandle: r.product?.handle ?? null,
      productId: r.productId ?? null,
    })),
    total,
    page,
    pageSize,
  });
});

// Admin: full sync-job log across all shops
app.get('/admin/sync-log', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid' });
  if (!hasPlatformGlobalAccess(user.platformRole)) return reply.code(403).send({ error: 'Platform admin/support role required' });

  const page = Math.max(1, parseInt(String(request.query.page ?? '1'), 10));
  const pageSize = Math.min(100, Math.max(10, parseInt(String(request.query.pageSize ?? '50'), 10)));
  const statusFilter = typeof request.query.status === 'string' && request.query.status ? request.query.status : undefined;
  const shopIdFilter = typeof request.query.shopId === 'string' && request.query.shopId ? request.query.shopId : undefined;
  const typeFilter = typeof request.query.type === 'string' && request.query.type ? request.query.type : undefined;
  const since = typeof request.query.since === 'string' && request.query.since ? new Date(request.query.since) : new Date(Date.now() - 24 * 60 * 60 * 1000);
  const showDismissed = request.query.showDismissed === 'true';

  const where = {
    createdAt: { gte: since },
    ...(statusFilter ? { status: statusFilter as any } : {}),
    ...(shopIdFilter ? { shopId: shopIdFilter } : {}),
    ...(typeFilter ? { type: typeFilter } : {}),
    ...(showDismissed ? {} : { dismissed: false }),
  };

  const [jobs, total] = await Promise.all([
    prisma.syncJob.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        type: true,
        status: true,
        retries: true,
        error: true,
        dismissed: true,
        createdAt: true,
        runAt: true,
        finishedAt: true,
        shop: { select: { id: true, shopUrl: true } },
      },
    }),
    prisma.syncJob.count({ where }),
  ]);

  return { jobs, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
});

app.post('/admin/sync-jobs/clear-failed', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid' });
  if (!hasPlatformGlobalAccess(user.platformRole)) return reply.code(403).send({ error: 'Platform admin/support role required' });

  const body = request.body as { shopId?: string } | undefined;
  const shopId = typeof body?.shopId === 'string' && body.shopId ? body.shopId : undefined;

  const result = await prisma.syncJob.updateMany({
    where: { status: 'failed', dismissed: false, ...(shopId ? { shopId } : {}) },
    data: { dismissed: true },
  });

  return { ok: true, dismissed: result.count };
});

app.get('/admin/shops', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }

  if (!hasPlatformGlobalAccess(user.platformRole)) {
    return reply.code(403).send({ error: 'Platform admin/support role required' });
  }

  const query = request.query as Record<string, unknown>;
  const rawQ = typeof query.q === 'string' ? query.q.trim() : '';
  const plan = query.plan === 'unlimited' || query.plan === 'standard' ? query.plan : 'all';
  const status = query.status === 'connected' || query.status === 'disconnected' ? query.status : 'all';
  const sortBy = query.sortBy === 'shopUrl' || query.sortBy === 'status' || query.sortBy === 'plan' ? query.sortBy : 'createdAt';
  const sortDir = query.sortDir === 'asc' || query.sortDir === 'desc' ? query.sortDir : 'desc';
  const page = Math.max(1, Number(query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 20)));

  const where: any = {
    ...(status !== 'all' ? { status } : {}),
    ...(plan === 'unlimited'
      ? { subscription: { is: { status: 'unlimited' } } }
      : plan === 'standard'
        ? {
            OR: [
              { subscription: null },
              { subscription: { is: { status: { not: 'unlimited' } } } },
            ],
          }
        : {}),
    ...(rawQ
      ? {
          AND: [
            {
              OR: [
                { shopUrl: { contains: rawQ, mode: 'insensitive' } },
                { organization: { is: { name: { contains: rawQ, mode: 'insensitive' } } } },
                {
                  memberships: {
                    some: {
                      user: {
                        email: {
                          contains: rawQ,
                          mode: 'insensitive',
                        },
                      },
                    },
                  },
                },
              ],
            },
          ],
        }
      : {}),
  };

  const orderBy: any =
    sortBy === 'shopUrl'
      ? { shopUrl: sortDir }
      : sortBy === 'status'
        ? { status: sortDir }
        : sortBy === 'plan'
          ? { subscription: { status: sortDir } }
          : { createdAt: sortDir };

  const [total, shops] = await Promise.all([
    prisma.shop.count({ where }),
    prisma.shop.findMany({
      where,
      include: {
        organization: { select: { id: true, name: true } },
        subscription: {
          select: {
            status: true,
            basePriceMinor: true,
            includedUnitsPerMonth: true,
            overageUnitMinor: true,
            currentPeriodEnd: true,
          },
        },
        memberships: {
          select: { user: { select: { id: true, email: true } } },
        },
      },
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return {
    count: shops.length,
    total,
    page,
    pageSize,
    totalPages,
    shops: shops.map((shop) => ({
      id: shop.id,
      shopUrl: shop.shopUrl,
      displayName: (shop as any).displayName ?? null,
      status: shop.status,
      organization: shop.organization ? { id: shop.organization.id, name: shop.organization.name } : null,
      owners: shop.memberships.map((m) => m.user),
      subscription: shop.subscription,
      plan: shop.subscription?.status === 'unlimited' ? 'unlimited' : 'standard',
    })),
  };
});

app.put('/admin/shops/:id/organization', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }

  if (!hasPlatformGlobalAccess(user.platformRole)) {
    return reply.code(403).send({ error: 'Platform admin/support role required' });
  }

  const body = request.body as { organizationId: string | null };
  const organizationId = body.organizationId || null;

  if (organizationId) {
    const org = await prisma.organization.findUnique({ where: { id: organizationId } });
    if (!org) {
      return reply.code(404).send({ error: 'Organization not found' });
    }
  }

  const shop = await prisma.shop.findUnique({ where: { id: request.params.id } });
  if (!shop) {
    return reply.code(404).send({ error: 'Shop not found' });
  }

  await prisma.shop.update({ where: { id: shop.id }, data: { organizationId } });

  await createBillingOpsAudit({
    userId: user.id,
    action: 'admin_shop_org_update',
    targetType: 'shop',
    targetId: shop.id,
    metadataJson: { organizationId },
  });

  return { ok: true, organizationId };
});

app.put('/admin/shops/:id/plan', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const parsed = adminShopPlanSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }

  if (!hasPlatformGlobalAccess(user.platformRole)) {
    return reply.code(403).send({ error: 'Platform admin/support role required' });
  }

  const shop = await prisma.shop.findUnique({ where: { id: request.params.id } });
  if (!shop) {
    return reply.code(404).send({ error: 'Shop not found' });
  }

  await applyAdminShopPlan({ shopId: shop.id, plan: parsed.data.plan });

  await createBillingOpsAudit({
    userId: user.id,
    action: 'admin_shop_plan_update',
    targetType: 'shop',
    targetId: shop.id,
    metadataJson: { plan: parsed.data.plan },
  });

  const subscription = await prisma.shopSubscription.findUnique({ where: { shopId: shop.id } });
  return { ok: true, plan: parsed.data.plan, subscription };
});

app.post('/admin/shops/:id/archive', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }

  if (!hasPlatformGlobalAccess(user.platformRole)) {
    return reply.code(403).send({ error: 'Platform admin/support role required' });
  }

  const shop = await prisma.shop.findUnique({ where: { id: request.params.id } });
  if (!shop) {
    return reply.code(404).send({ error: 'Shop not found' });
  }

  await prisma.shop.update({ where: { id: shop.id }, data: { status: 'disconnected' } });
  await prisma.user.updateMany({ where: { shopId: shop.id }, data: { shopId: null } });
  await prisma.shopSubscription.updateMany({ where: { shopId: shop.id }, data: { status: 'canceled' } });

  await createBillingOpsAudit({
    userId: user.id,
    action: 'admin_shop_archive',
    targetType: 'shop',
    targetId: shop.id,
    metadataJson: { shopUrl: shop.shopUrl },
  });

  return { ok: true, archived: true };
});

app.put('/admin/shops/:id/display-name', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }

  if (!hasPlatformGlobalAccess(user.platformRole)) {
    return reply.code(403).send({ error: 'Platform admin/support role required' });
  }

  const shop = await prisma.shop.findUnique({ where: { id: request.params.id } });
  if (!shop) {
    return reply.code(404).send({ error: 'Shop not found' });
  }

  const body = request.body as { displayName?: string | null };
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() || null : null;

  await prisma.shop.update({ where: { id: shop.id }, data: { displayName } });

  return { ok: true, displayName };
});

app.delete('/admin/shops/:id', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }

  if (!hasPlatformGlobalAccess(user.platformRole)) {
    return reply.code(403).send({ error: 'Platform admin/support role required' });
  }

  const shop = await prisma.shop.findUnique({ where: { id: request.params.id } });
  if (!shop) {
    return reply.code(404).send({ error: 'Shop not found' });
  }

  const body = request.body as { confirmShopUrl?: string };
  if (body.confirmShopUrl?.trim() !== shop.shopUrl) {
    return reply.code(400).send({ error: 'Bekræftelse mislykkedes: shop URL matcher ikke.' });
  }

  // Cascade delete in dependency order (FieldValue has no shopId — delete via field definitions)
  const fieldDefIds = (await prisma.fieldDefinition.findMany({ where: { shopId: shop.id }, select: { id: true } })).map((f) => f.id);

  await prisma.usageEvent.deleteMany({ where: { shopId: shop.id } });
  await prisma.usageNotice.deleteMany({ where: { shopId: shop.id } });
  await prisma.billingLedgerMonth.deleteMany({ where: { shopId: shop.id } });
  await prisma.aiUsage.deleteMany({ where: { shopId: shop.id } });
  await prisma.shopSetting.deleteMany({ where: { shopId: shop.id } });
  await prisma.sourceDataRow.deleteMany({ where: { shopId: shop.id } });
  await prisma.source.deleteMany({ where: { shopId: shop.id } });
  await prisma.promptTemplate.deleteMany({ where: { shopId: shop.id } });
  await prisma.draft.deleteMany({ where: { shopId: shop.id } });
  await prisma.syncRun.deleteMany({ where: { shopId: shop.id } });
  await prisma.syncJob.deleteMany({ where: { shopId: shop.id } });
  await prisma.snapshot.deleteMany({ where: { shopId: shop.id } });
  await prisma.changeLog.deleteMany({ where: { shopId: shop.id } });
  if (fieldDefIds.length > 0) {
    await prisma.fieldValue.deleteMany({ where: { fieldDefinitionId: { in: fieldDefIds } } });
  }
  await prisma.fieldDefinition.deleteMany({ where: { shopId: shop.id } });
  // Delete ProductCollection join table rows via collection (cascade) — delete collections first
  await prisma.collection.deleteMany({ where: { shopId: shop.id } });
  await prisma.variant.deleteMany({ where: { product: { shopId: shop.id } } });
  await prisma.product.deleteMany({ where: { shopId: shop.id } });
  await prisma.shopMembership.deleteMany({ where: { shopId: shop.id } });
  await prisma.user.updateMany({ where: { shopId: shop.id }, data: { shopId: null } });
  await prisma.shopSubscription.deleteMany({ where: { shopId: shop.id } });
  await prisma.referralCommission.deleteMany({ where: { shopId: shop.id } });
  await prisma.shop.delete({ where: { id: shop.id } });

  await createBillingOpsAudit({
    userId: user.id,
    action: 'admin_shop_delete',
    targetType: 'shop',
    targetId: shop.id,
    metadataJson: { shopUrl: shop.shopUrl },
  });

  return { ok: true, deleted: true };
});

// Shop members can also update their shop display name
app.put('/settings/shops/display-name', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }

  const shopId = resolveActiveShopId(request, user);
  if (!shopId) {
    return reply.code(400).send({ error: 'Ingen aktiv webshop valgt.' });
  }

  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { id: true, organizationId: true },
  });
  if (!shop) {
    return reply.code(404).send({ error: 'Shop not found.' });
  }

  // Allow: shop member OR org admin/owner
  const [shopMembership, orgMembership] = await Promise.all([
    prisma.shopMembership.findFirst({ where: { shopId, userId: user.id }, select: { id: true } }),
    shop.organizationId
      ? prisma.organizationMembership.findFirst({ where: { organizationId: shop.organizationId, userId: user.id }, select: { role: true } })
      : null,
  ]);

  const isShopMember = Boolean(shopMembership);
  const isOrgAdmin = orgMembership?.role === 'admin' || orgMembership?.role === 'owner';

  if (!isShopMember && !isOrgAdmin) {
    return reply.code(403).send({ error: 'Du skal være shop-member eller org-admin for at ændre dette.' });
  }

  const body = request.body as { displayName?: string | null };
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() || null : null;

  await prisma.shop.update({ where: { id: shopId }, data: { displayName } });

  return { ok: true, displayName };
});

app.get('/tenancy/context', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }

  const globalAccess = hasPlatformGlobalAccess(user.platformRole);

  const [organizations, shopMemberships] = await Promise.all([
    prisma.organization.findMany({
      where: globalAccess
        ? undefined
        : {
            OR: [
              { memberships: { some: { userId: user.id } } },
              { shops: { some: { memberships: { some: { userId: user.id } } } } },
            ],
          },
      include: {
        memberships: {
          where: { userId: user.id },
          select: { role: true },
        },
        shops: {
          select: {
            id: true,
            shopUrl: true,
            displayName: true,
            status: true,
            organizationId: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.shopMembership.findMany({
      where: { userId: user.id },
      select: {
        role: true,
        shop: {
          select: {
            id: true,
            shopUrl: true,
            displayName: true,
            status: true,
            organizationId: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  const shopsById = new Map<string, { id: string; shopUrl: string; displayName: string | null; status: string; organizationId: string | null }>();

  for (const org of organizations) {
    for (const shop of org.shops) {
      shopsById.set(shop.id, {
        id: shop.id,
        shopUrl: shop.shopUrl,
        displayName: (shop as any).displayName ?? null,
        status: shop.status,
        organizationId: shop.organizationId,
      });
    }
  }

  for (const membership of shopMemberships) {
    shopsById.set(membership.shop.id, {
      id: membership.shop.id,
      shopUrl: membership.shop.shopUrl,
      displayName: (membership.shop as any).displayName ?? null,
      status: membership.shop.status,
      organizationId: membership.shop.organizationId,
    });
  }

  const fallbackShopId = user.shopId ?? (shopsById.values().next().value?.id ?? null);
  const requestedShopId = getHeaderShopId(request);
  const candidateShopId = requestedShopId ?? fallbackShopId;

  let selectedShopId: string | null = null;
  if (candidateShopId) {
    const allowed = await ensureShopAccess({ user, shopId: candidateShopId });
    selectedShopId = allowed ? candidateShopId : fallbackShopId;
  }

  return {
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      role: user.role,
      platformRole: user.platformRole,
    },
    selectedShopId,
    organizations: organizations.map((org) => ({
      id: org.id,
      name: org.name,
      role: org.memberships[0]?.role ?? null,
      shops: org.shops,
    })),
    shops: Array.from(shopsById.values()),
  };
});

app.post('/tenancy/context/select-shop', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const parsed = activeShopSelectionSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }

  const allowed = await ensureShopAccess({ user, shopId: parsed.data.shopId });
  if (!allowed) {
    return reply.code(403).send({ error: 'Forbidden shop access' });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { shopId: parsed.data.shopId },
  });

  const token = app.jwt.sign({
    id: user.id,
    email: user.email,
    role: user.role,
    shopId: parsed.data.shopId,
    platformRole: user.platformRole,
  }, { expiresIn: '24h' });

  return { ok: true, shopId: parsed.data.shopId, token };
});

app.get('/shops/:id/subscription', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }

  const allowed = await ensureShopAccess({ user, shopId: request.params.id });
  if (!allowed) {
    return reply.code(403).send({ error: 'Forbidden shop access' });
  }

  const subscription = await prisma.shopSubscription.findUnique({
    where: { shopId: request.params.id },
  });

  if (!subscription) {
    return reply.code(404).send({ error: 'Subscription not found for shop' });
  }

  return { subscription };
});

app.post('/shops/:id/subscription', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const parsed = setupSubscriptionSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }

  const allowed = await ensureShopAccess({ user, shopId: request.params.id });
  if (!allowed) {
    return reply.code(403).send({ error: 'Forbidden shop access' });
  }

  const now = new Date();
  const currentPeriodStart = parsed.data.currentPeriodStart ? new Date(parsed.data.currentPeriodStart) : now;
  const currentPeriodEnd = parsed.data.currentPeriodEnd
    ? new Date(parsed.data.currentPeriodEnd)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));

  const shop = await prisma.shop.findUnique({
    where: { id: request.params.id },
    include: { organization: true },
  });

  if (!shop) {
    return reply.code(404).send({ error: 'Shop not found' });
  }

  if (!shop.organization) {
    return reply.code(400).send({ error: 'Shop has no organization. Run backfill first.' });
  }

  const isUnlimitedPlan = parsed.data.status === 'unlimited';
  const unlimitedPeriodEnd = new Date(Date.UTC(2099, 11, 31, 23, 59, 59, 999));

  const subscription = await prisma.shopSubscription.upsert({
    where: { shopId: request.params.id },
    update: {
      status: parsed.data.status,
      currentPeriodStart,
      currentPeriodEnd: isUnlimitedPlan ? unlimitedPeriodEnd : currentPeriodEnd,
      basePriceMinor: isUnlimitedPlan ? 0 : parsed.data.basePriceMinor,
      includedUnitsPerMonth: isUnlimitedPlan ? 2147483647 : parsed.data.includedUnitsPerMonth,
      overageUnitMinor: isUnlimitedPlan ? 0 : parsed.data.overageUnitMinor,
    },
    create: {
      shopId: request.params.id,
      status: parsed.data.status,
      currentPeriodStart,
      currentPeriodEnd: isUnlimitedPlan ? unlimitedPeriodEnd : currentPeriodEnd,
      basePriceMinor: isUnlimitedPlan ? 0 : parsed.data.basePriceMinor,
      includedUnitsPerMonth: isUnlimitedPlan ? 2147483647 : parsed.data.includedUnitsPerMonth,
      overageUnitMinor: isUnlimitedPlan ? 0 : parsed.data.overageUnitMinor,
    },
  });

  return { subscription };
});

app.get('/shops/:id/usage', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }

  const allowed = await ensureShopAccess({ user, shopId: request.params.id });
  if (!allowed) {
    return reply.code(403).send({ error: 'Forbidden shop access' });
  }

  const monthKeyRaw = (request.query.month as string | undefined) ?? monthKeyFromDateUtc(new Date());
  try {
    parseMonthKey(monthKeyRaw);
  } catch {
    return reply.code(400).send({ error: 'month must be YYYY-MM' });
  }

  const [subscription, usage, notices] = await Promise.all([
    prisma.shopSubscription.findUnique({ where: { shopId: request.params.id } }),
    prisma.usageEvent.aggregate({
      where: {
        shopId: request.params.id,
        billingMonth: monthKeyRaw,
        type: 'ai_datapoint_generated',
      },
      _sum: { quantity: true },
    }),
    prisma.usageNotice.findMany({
      where: {
        shopId: request.params.id,
        monthKey: monthKeyRaw,
      },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  const includedUnits = subscription?.includedUnitsPerMonth ?? 100;
  const consumedUnits = usage._sum.quantity ?? 0;
  const overageUnits = Math.max(consumedUnits - includedUnits, 0);

  return {
    monthKey: monthKeyRaw,
    includedUnits,
    consumedUnits,
    overageUnits,
    notices,
  };
});

app.get('/shops/:id/billing-preview', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }

  const allowed = await ensureShopAccess({ user, shopId: request.params.id });
  if (!allowed) {
    return reply.code(403).send({ error: 'Forbidden shop access' });
  }

  const monthKeyRaw = (request.query.month as string | undefined) ?? monthKeyFromDateUtc(new Date());
  try {
    parseMonthKey(monthKeyRaw);
  } catch {
    return reply.code(400).send({ error: 'month must be YYYY-MM' });
  }

  const subscription = await prisma.shopSubscription.findUnique({ where: { shopId: request.params.id } });
  if (!subscription) {
    return reply.code(404).send({ error: 'Subscription not found for shop' });
  }

  const usage = await prisma.usageEvent.aggregate({
    where: {
      shopId: request.params.id,
      billingMonth: monthKeyRaw,
      type: 'ai_datapoint_generated',
    },
    _sum: { quantity: true },
  });

  const consumedUnits = usage._sum.quantity ?? 0;
  const firstMonthKey = monthKeyFromDateUtc(subscription.createdAt);
  const isFirstBillingMonth = monthKeyRaw === firstMonthKey;

  const breakdown = calculateMonthlyCharge({
    monthKey: monthKeyRaw,
    consumedUnits,
    basePriceMinor: subscription.basePriceMinor,
    includedUnitsPerMonth: subscription.includedUnitsPerMonth,
    overageUnitMinor: subscription.overageUnitMinor,
    vatRateBps: 2500,
    isFirstBillingMonth,
    activatedAt: isFirstBillingMonth ? subscription.createdAt : undefined,
  });

  return {
    subscription,
    breakdown,
    pricing: {
      currency: 'DKK',
      pricesExcludeVat: true,
      vatRateBps: 2500,
    },
  };
});

app.get('/shops/:id/notifications', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }

  const allowed = await ensureShopAccess({ user, shopId: request.params.id });
  if (!allowed) {
    return reply.code(403).send({ error: 'Forbidden shop access' });
  }

  const monthKeyRaw = (request.query.month as string | undefined) ?? monthKeyFromDateUtc(new Date());
  try {
    parseMonthKey(monthKeyRaw);
  } catch {
    return reply.code(400).send({ error: 'month must be YYYY-MM' });
  }

  const notices = await prisma.usageNotice.findMany({
    where: {
      shopId: request.params.id,
      monthKey: monthKeyRaw,
    },
    orderBy: { createdAt: 'desc' },
  });

  return { monthKey: monthKeyRaw, notices };
});

app.post('/billing/close-month', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const parsed = billingCloseSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }

  if (!hasPlatformGlobalAccess(user.platformRole)) {
    return reply.code(403).send({ error: 'Platform admin/support role required' });
  }

  const subscriptions = await prisma.shopSubscription.findMany({
    where: { status: { in: ['active', 'trialing', 'past_due'] } },
    orderBy: { createdAt: 'asc' },
  });

  const rows: Array<{
    shopId: string;
    consumedUnits: number;
    overageUnits: number;
    subtotalMinor: number;
    totalAmountMinor: number;
  }> = [];

  for (const subscription of subscriptions) {
    const usage = await prisma.usageEvent.aggregate({
      where: {
        shopId: subscription.shopId,
        billingMonth: parsed.data.monthKey,
        type: 'ai_datapoint_generated',
      },
      _sum: { quantity: true },
    });

    const consumedUnits = usage._sum.quantity ?? 0;

    const breakdown = buildBillingCloseBreakdown({
      monthKey: parsed.data.monthKey,
      consumedUnits,
      basePriceMinor: subscription.basePriceMinor,
      includedUnitsPerMonth: subscription.includedUnitsPerMonth,
      overageUnitMinor: subscription.overageUnitMinor,
      subscriptionCreatedAt: subscription.createdAt,
    });

    const row = await prisma.billingLedgerMonth.upsert({
      where: {
        shopId_monthKey: {
          shopId: subscription.shopId,
          monthKey: parsed.data.monthKey,
        },
      },
      update: {
        includedUnits: breakdown.includedUnits,
        consumedUnits: breakdown.consumedUnits,
        overageUnits: breakdown.overageUnits,
        baseAmountMinor: breakdown.baseAmountMinor,
        overageAmountMinor: breakdown.overageAmountMinor,
        subtotalMinor: breakdown.subtotalMinor,
        vatRateBps: breakdown.vatRateBps,
        vatAmountMinor: breakdown.vatAmountMinor,
        totalAmountMinor: breakdown.totalAmountMinor,
        finalizedAt: parsed.data.finalize ? new Date() : null,
      },
      create: {
        shopId: subscription.shopId,
        monthKey: parsed.data.monthKey,
        includedUnits: breakdown.includedUnits,
        consumedUnits: breakdown.consumedUnits,
        overageUnits: breakdown.overageUnits,
        baseAmountMinor: breakdown.baseAmountMinor,
        overageAmountMinor: breakdown.overageAmountMinor,
        subtotalMinor: breakdown.subtotalMinor,
        vatRateBps: breakdown.vatRateBps,
        vatAmountMinor: breakdown.vatAmountMinor,
        totalAmountMinor: breakdown.totalAmountMinor,
        finalizedAt: parsed.data.finalize ? new Date() : null,
      },
    });

    rows.push({
      shopId: row.shopId,
      consumedUnits: row.consumedUnits,
      overageUnits: row.overageUnits,
      subtotalMinor: row.subtotalMinor,
      totalAmountMinor: row.totalAmountMinor,
    });

    // Auto-create referral commissions when finalized
    if (parsed.data.finalize && row.subtotalMinor > 0) {
      try {
        const shop = await prisma.shop.findUnique({
          where: { id: subscription.shopId },
          select: { organizationId: true },
        });
        if (shop?.organizationId) {
          const agencyRelation = await prisma.agencyClientRelation.findFirst({
            where: { clientOrgId: shop.organizationId, status: 'active' },
            select: { id: true, agencyOrgId: true, clientOrgId: true, commissionRateBps: true },
          });
          if (agencyRelation) {
            const commissionMinor = Math.round(row.subtotalMinor * (agencyRelation.commissionRateBps / 10000));
            await prisma.referralCommission.upsert({
              where: { agencyRelationId_shopId_billingMonth: { agencyRelationId: agencyRelation.id, shopId: subscription.shopId, billingMonth: parsed.data.monthKey } },
              update: { grossAmountMinor: row.subtotalMinor, commissionMinor, commissionRateBps: agencyRelation.commissionRateBps },
              create: {
                agencyRelationId: agencyRelation.id,
                agencyOrgId: agencyRelation.agencyOrgId,
                clientOrgId: agencyRelation.clientOrgId,
                shopId: subscription.shopId,
                billingMonth: parsed.data.monthKey,
                grossAmountMinor: row.subtotalMinor,
                commissionMinor,
                commissionRateBps: agencyRelation.commissionRateBps,
              },
            });
          }
        }
      } catch (commErr) {
        request.log.error({ commErr, shopId: subscription.shopId, monthKey: parsed.data.monthKey }, 'auto referral commission creation failed');
      }
    }
  }

  await createBillingOpsAudit({
    userId: user.id,
    action: 'billing_close_month',
    targetType: 'month',
    targetId: parsed.data.monthKey,
    metadataJson: {
      finalized: parsed.data.finalize,
      affectedShops: rows.length,
    },
  });

  return {
    monthKey: parsed.data.monthKey,
    rows,
    count: rows.length,
    finalized: parsed.data.finalize,
  };
});

app.get('/billing/ledger', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }

  if (!hasPlatformGlobalAccess(user.platformRole)) {
    return reply.code(403).send({ error: 'Platform admin/support role required' });
  }

  const monthKeyRaw = (request.query.month as string | undefined) ?? monthKeyFromDateUtc(new Date());
  const shopId = (request.query.shopId as string | undefined) ?? undefined;

  try {
    parseMonthKey(monthKeyRaw);
  } catch {
    return reply.code(400).send({ error: 'month must be YYYY-MM' });
  }

  const rows = await prisma.billingLedgerMonth.findMany({
    where: {
      monthKey: monthKeyRaw,
      ...(shopId ? { shopId } : {}),
    },
    include: {
      shop: {
        select: {
          id: true,
          shopUrl: true,
          organizationId: true,
        },
      },
    },
    orderBy: [{ totalAmountMinor: 'desc' }, { shopId: 'asc' }],
  });

  const totals = rows.reduce(
    (acc, row) => {
      acc.subtotalMinor += row.subtotalMinor;
      acc.totalAmountMinor += row.totalAmountMinor;
      acc.overageUnits += row.overageUnits;
      return acc;
    },
    { subtotalMinor: 0, totalAmountMinor: 0, overageUnits: 0 },
  );

  return {
    monthKey: monthKeyRaw,
    count: rows.length,
    totals,
    rows,
  };
});

app.get('/billing/audit-log', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }

  if (!hasPlatformGlobalAccess(user.platformRole)) {
    return reply.code(403).send({ error: 'Platform admin/support role required' });
  }

  const limit = Math.min(500, Math.max(1, Number(request.query.limit ?? 100)));
  const action = (request.query.action as string | undefined) ?? undefined;

  const rows = await prisma.billingOpsAuditLog.findMany({
    where: {
      ...(action ? { action } : {}),
    },
    include: {
      user: {
        select: {
          id: true,
          email: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return { count: rows.length, rows };
});

app.post('/billing/notices/resend', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const parsed = resendNoticeSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }

  if (!hasPlatformGlobalAccess(user.platformRole)) {
    return reply.code(403).send({ error: 'Platform admin/support role required' });
  }

  const notice = await prisma.usageNotice.findUnique({
    where: {
      shopId_monthKey_kind: {
        shopId: parsed.data.shopId,
        monthKey: parsed.data.monthKey,
        kind: parsed.data.kind,
      },
    },
    include: {
      shop: {
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
      },
    },
  });

  if (!notice) {
    return reply.code(404).send({ error: 'Usage notice not found for shop/month/kind' });
  }

  const [usage, subscription] = await Promise.all([
    prisma.usageEvent.aggregate({
      where: {
        shopId: parsed.data.shopId,
        billingMonth: parsed.data.monthKey,
        type: 'ai_datapoint_generated',
      },
      _sum: { quantity: true },
    }),
    prisma.shopSubscription.findUnique({ where: { shopId: parsed.data.shopId } }),
  ]);

  const consumedUnits = usage._sum.quantity ?? 0;
  const includedUnits = subscription?.includedUnitsPerMonth ?? 100;

  const recipients = (notice.shop.organization?.memberships ?? [])
    .map((membership) => membership.user.email)
    .filter((email): email is string => Boolean(email));

  await sendBillingNoticeEmail({
    recipients,
    subject:
      parsed.data.kind === 'overage_started'
        ? 'EL-PIM: Overforbrug af AI datapunkter er startet'
        : 'EL-PIM: 100/100 inkluderede AI datapunkter er brugt',
    html: `<p>Hej,</p><p>Shoppen har brugt <strong>${consumedUnits}</strong> AI-genererede datapunkter i ${parsed.data.monthKey}.</p><p>Inkluderet i abonnementet: <strong>${includedUnits}</strong>.</p><p>${
      parsed.data.kind === 'overage_started'
        ? 'Gratis grænse er overskredet. Nye AI-genererede datapunkter faktureres nu.'
        : 'I har nået den inkluderede grænse på 100 datapunkter.'
    }</p>${env.APP_BASE_URL ? `<p><a href="${env.APP_BASE_URL}/settings/billing">Gå til Billing Ops</a></p>` : ''}`,
  });

  await createBillingOpsAudit({
    userId: user.id,
    action: 'billing_notice_resend',
    targetType: 'shop',
    targetId: parsed.data.shopId,
    metadataJson: {
      monthKey: parsed.data.monthKey,
      kind: parsed.data.kind,
      recipients: recipients.length,
    },
  });

  return { ok: true, recipients: recipients.length };
});

// GET /billing/status — always returns true for internal use
app.get('/billing/status', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  return reply.send({ hasAccess: true });
});

// POST /onboarding/request-setup — customer requests "Gør det for mig"
app.post('/onboarding/request-setup', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid.' });

  const membership = await prisma.organizationMembership.findFirst({
    where: { userId: user.id },
    include: { organization: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const orgName = membership?.organization?.name ?? 'Ukendt organisation';
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ') || '–';
  const notifyTo = env.NOTIFY_EMAIL ?? env.EMAIL_FROM;

  if (notifyTo && env.RESEND_API_KEY && env.EMAIL_FROM) {
    const subject = `Ny opsætningsanmodning fra ${user.email}`;
    const html = `
      <p><strong>Kunde:</strong> ${fullName} (${user.email})</p>
      <p><strong>Organisation:</strong> ${orgName}</p>
      <p><strong>Tidspunkt:</strong> ${new Date().toLocaleString('da-DK', { timeZone: 'Europe/Copenhagen' })}</p>
      <p>Kunden ønsker hjælp til at forbinde sin Shopify-butik via "Gør det for mig"-funktionen i onboarding.</p>
    `;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: notifyTo, subject, html }),
    }).catch((err) => { request.log.error(err, 'Failed to send setup request notification'); });
  }

  return reply.send({ ok: true });
});

// ── Support chat message ─────────────────────────────────────────────────────
app.post('/support/message', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid.' });

  const { message } = (request.body ?? {}) as { message?: string };
  if (!message || typeof message !== 'string' || message.trim().length < 2) {
    return reply.code(400).send({ error: 'Besked er påkrævet.' });
  }

  const shopId = resolveActiveShopId(request, user);
  const shopRecord = shopId ? await prisma.shop.findUnique({ where: { id: shopId }, select: { shopUrl: true } }).catch(() => null) : null;
  const membership = await prisma.organizationMembership.findFirst({
    where: { userId: user.id },
    include: { organization: { select: { name: true } } },
  }).catch(() => null);

  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ') || '–';
  const orgName = membership?.organization?.name ?? '–';
  const shopUrl = shopRecord?.shopUrl ?? '–';
  const notifyTo = env.NOTIFY_EMAIL ?? env.EMAIL_FROM;

  if (notifyTo && env.RESEND_API_KEY && env.EMAIL_FROM) {
    const subject = `Kundebesked fra ${user.email}`;
    const html = `
      <p><strong>Navn:</strong> ${fullName}</p>
      <p><strong>Email:</strong> <a href="mailto:${user.email}">${user.email}</a></p>
      <p><strong>Organisation:</strong> ${orgName}</p>
      <p><strong>Webshop:</strong> ${shopUrl}</p>
      <p><strong>Tidspunkt:</strong> ${new Date().toLocaleString('da-DK', { timeZone: 'Europe/Copenhagen' })}</p>
      <hr/>
      <p><strong>Besked:</strong></p>
      <blockquote style="border-left:3px solid #6366f1;margin:8px 0;padding:8px 16px;color:#334155;">${message.replace(/\n/g, '<br/>')}</blockquote>
    `;
    await sendEmail(notifyTo, subject, html).catch((err: unknown) => {
      request.log.error(err, 'Failed to send support message');
    });
  }

  return reply.send({ ok: true });
});

app.get('/integrations/openai', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const key = await getPlatformOpenAiKey();
  return { configured: Boolean(key) };
});

app.put('/integrations/openai', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const parsed = openAiKeySchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }

  if (!hasPlatformGlobalAccess(user.platformRole)) {
    return reply.code(403).send({ error: 'Platform admin role required to set OpenAI key.' });
  }

  const encryptedKey = encryptSecret(parsed.data.apiKey, env.MASTER_ENCRYPTION_KEY);
  await prisma.platformSetting.upsert({
    where: { key: 'openai_api_key' },
    update: { valueJson: { encryptedKey } as any },
    create: { key: 'openai_api_key', valueJson: { encryptedKey } as any },
  });

  return { configured: true };
});

app.post('/shops/connect', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }
  const parsed = connectShopSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }

  const currentUser = await getCurrentUser(request);
  if (!currentUser) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }

  const client = new ShopifyGraphQLClient({
    storeUrl: parsed.data.storeUrl,
    adminToken: parsed.data.token,
  });

  try {
    await client.execute<{ shop: { id: string } }>(`query ValidateShopAccess { shop { id } }`);
  } catch {
    return reply.code(400).send({ error: 'Invalid Shopify store URL or Admin API token.' });
  }

  const encryptedAdminToken = encryptSecret(parsed.data.token, env.MASTER_ENCRYPTION_KEY);
  const existingOrgMembership = await prisma.organizationMembership.findFirst({
    where: {
      userId: currentUser.id,
      role: { in: ['owner', 'admin'] },
    },
    include: { organization: true },
    orderBy: { createdAt: 'asc' },
  });

  const organization =
    existingOrgMembership?.organization ??
    (await prisma.organization.create({
      data: {
        name: `${currentUser.email.split('@')[0] ?? 'Customer'} Organization`,
      },
    }));

  if (!existingOrgMembership) {
    await prisma.organizationMembership.create({
      data: {
        organizationId: organization.id,
        userId: currentUser.id,
        role: currentUser.role === 'owner' ? 'owner' : 'member',
      },
    });
  }

  const shop = await prisma.shop.upsert({
    where: { shopUrl: parsed.data.storeUrl },
    update: { encryptedAdminToken, status: 'connected', organizationId: organization.id },
    create: { shopUrl: parsed.data.storeUrl, encryptedAdminToken, status: 'connected', organizationId: organization.id },
  });

  await prisma.shopMembership.upsert({
    where: {
      shopId_userId: {
        shopId: shop.id,
        userId: currentUser.id,
      },
    },
    update: {
      role: 'member',
    },
    create: {
      shopId: shop.id,
      userId: currentUser.id,
      role: 'member',
    },
  });

  await prisma.user.update({
    where: { id: currentUser.id },
    data: { shopId: shop.id },
  });

  let warning: string | undefined;
  let subscriptionReady = false;

  const trialPolicy = await getTrialPolicy();
  const existingSubscription = await prisma.shopSubscription.findUnique({ where: { shopId: shop.id } });
  subscriptionReady = isSubscriptionAccessAllowed(existingSubscription as any);

  if (!existingSubscription && trialPolicy.enabled) {
    const now = new Date();
    const periodStart = now;
    const periodEnd = new Date(now.getTime() + trialPolicy.trialDays * 24 * 60 * 60 * 1000);

    await prisma.shopSubscription.create({
      data: {
        shopId: shop.id,
        status: 'trialing',
        basePriceMinor: 99900,
        includedUnitsPerMonth: 100,
        overageUnitMinor: 50,
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
      },
    });

    warning = `Shop connected. Free trial activated for ${trialPolicy.trialDays} days.`;
    subscriptionReady = true;
  }

  if (!existingSubscription && !trialPolicy.enabled) {
    warning = 'Shop connected. Create/activate a subscription before using this webshop.';
    subscriptionReady = false;
  }

  try {
    await registerShopWebhooks(client, env.SHOPIFY_WEBHOOK_CALLBACK_BASE_URL);
  } catch {
    warning = warning
      ? `${warning} Shopify webhook registration also failed.`
      : 'Shop connected, but webhook registration failed. Please verify webhook settings and retry.';
  }

  await ensureBuiltInFields(shop.id);

  return { shop, warning, subscriptionReady };
});

app.get('/shops/ai-settings', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  const shopId = resolveActiveShopId(request, user);
  if (!shopId) return reply.code(400).send({ error: 'No shop' });
  const [introRow, masterRow, presetsRow] = await Promise.all([
    prisma.shopSetting.findUnique({ where: { shopId_key: { shopId, key: 'ai_introduction' } } }),
    prisma.shopSetting.findUnique({ where: { shopId_key: { shopId, key: 'master_prompt' } } }),
    prisma.shopSetting.findUnique({ where: { shopId_key: { shopId, key: 'quick_presets' } } }),
  ]);
  return reply.send({
    aiIntroduction: typeof (introRow?.valueJson as any) === 'string' ? (introRow?.valueJson as string) : '',
    masterPrompt: typeof (masterRow?.valueJson as any) === 'string' ? (masterRow?.valueJson as string) : null,
    quickPresets: Array.isArray(presetsRow?.valueJson) ? (presetsRow.valueJson as Array<{ label: string; instruction: string }>) : null,
  });
});

app.put('/shops/ai-settings', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  const shopId = resolveActiveShopId(request, user);
  if (!shopId) return reply.code(400).send({ error: 'No shop' });
  const { aiIntroduction, masterPrompt, quickPresets } = (request.body ?? {}) as { aiIntroduction?: string; masterPrompt?: string | null; quickPresets?: Array<{ label: string; instruction: string }> | null };
  const ops: Promise<unknown>[] = [];
  if (typeof aiIntroduction === 'string') {
    ops.push(prisma.shopSetting.upsert({
      where: { shopId_key: { shopId, key: 'ai_introduction' } },
      update: { valueJson: aiIntroduction },
      create: { shopId, key: 'ai_introduction', valueJson: aiIntroduction },
    }));
  }
  if (typeof masterPrompt === 'string') {
    ops.push(prisma.shopSetting.upsert({
      where: { shopId_key: { shopId, key: 'master_prompt' } },
      update: { valueJson: masterPrompt },
      create: { shopId, key: 'master_prompt', valueJson: masterPrompt },
    }));
  } else if (masterPrompt === null) {
    ops.push(prisma.shopSetting.deleteMany({ where: { shopId, key: 'master_prompt' } }));
  }
  if (Array.isArray(quickPresets)) {
    ops.push(prisma.shopSetting.upsert({
      where: { shopId_key: { shopId, key: 'quick_presets' } },
      update: { valueJson: quickPresets },
      create: { shopId, key: 'quick_presets', valueJson: quickPresets },
    }));
  } else if (quickPresets === null) {
    ops.push(prisma.shopSetting.deleteMany({ where: { shopId, key: 'quick_presets' } }));
  }
  if (ops.length === 0) return reply.code(400).send({ error: 'No valid fields provided' });
  await Promise.all(ops);
  return reply.send({ ok: true });
});

app.get('/shops/current', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user) return { shop: null };

  // 1. Legacy direct FK — fastest path
  if (user.shopId) {
    const shop = await prisma.shop.findUnique({ where: { id: user.shopId } });
    if (shop) return { shop };
  }

  // 2. Shop via organisation membership
  const orgShop = await prisma.shop.findFirst({
    where: {
      organization: { memberships: { some: { userId: user.id } } },
    },
    orderBy: { createdAt: 'asc' },
  });
  if (orgShop) return { shop: orgShop };

  // 3. Direct shop membership
  const shopMembership = await prisma.shopMembership.findFirst({
    where: { userId: user.id },
    include: { shop: true },
    orderBy: { createdAt: 'asc' },
  });
  if (shopMembership) return { shop: shopMembership.shop };

  return { shop: null };
});

app.delete('/shops/current', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const currentUser = await getCurrentUser(request);
  if (!currentUser) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }

  if (!currentUser.shopId) {
    return { ok: true, disconnected: false };
  }

  const shopId = currentUser.shopId;

  await prisma.user.update({
    where: { id: currentUser.id },
    data: { shopId: null },
  });

  const remainingUsers = await prisma.user.count({ where: { shopId } });
  if (remainingUsers === 0) {
    await prisma.shop.update({
      where: { id: shopId },
      data: { status: 'disconnected' },
    });
  }

  return { ok: true, disconnected: true };
});

app.get('/dashboard/overview', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  const shopId = resolveActiveShopId(request, user ?? {});
  if (!shopId) {
    return {
      connected: false,
      shopUrl: null,
      isAdmin: false,
      overview: {
        products: 0,
        variants: 0,
        collections: 0,
        fields: 0,
        mappings: 0,
        fieldValues: 0,
        productsNeverSynced: 0,
        productsDeletedByShopify: 0,
        productsPendingSync: 0,
        productsDraft: 0,
        productsByStatus: {},
        duplicateEans: [],
        aiUsage: {
          promptsAllTime: 0,
          prompts30d: 0,
          tokensAllTime: 0,
          tokens30d: 0,
          costDkkAllTime: 0,
          costDkk30d: 0,
        },
        sync: {
          queued: 0,
          running: 0,
          failed24h: 0,
          done24h: 0,
          conflictHolds7d: 0,
        },
        recentProducts: [],
      },
    };
  }

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [
    products,
    variants,
    collections,
    fields,
    mappings,
    fieldValues,
    usageAll,
    usage30d,
    promptCountAll,
    promptCount30d,
    queued,
    running,
    failed24h,
    done24h,
    conflictHolds7d,
    productsNeverSynced,
    productsDeletedByShopify,
    productsByStatusRaw,
    productsPendingSync,
    productsDraft,
    shopRecord,
    duplicateEansRaw,
    recentChanges,
  ] = await Promise.all([
    prisma.product.count({ where: { shopId, shopifyDeletedAt: null } }),
    prisma.variant.count({ where: { product: { shopId, shopifyDeletedAt: null } } }),
    prisma.collection.count({ where: { shopId } }),
    prisma.fieldDefinition.count({ where: { shopId } }),
    prisma.mapping.count({ where: { fieldDefinition: { shopId } } }),
    prisma.fieldValue.count({ where: { fieldDefinition: { shopId } } }),
    prisma.aiUsage.aggregate({
      where: { shopId },
      _sum: { totalTokens: true, estimatedCostDkk: true },
    }),
    prisma.aiUsage.aggregate({
      where: { shopId, createdAt: { gte: since30d } },
      _sum: { totalTokens: true, estimatedCostDkk: true },
    }),
    prisma.aiUsage.count({ where: { shopId } }),
    prisma.aiUsage.count({ where: { shopId, createdAt: { gte: since30d } } }),
    prisma.syncJob.count({ where: { shopId, status: 'queued' } }),
    prisma.syncJob.count({ where: { shopId, status: 'running' } }),
    prisma.syncJob.count({ where: { shopId, status: 'failed', dismissed: false, createdAt: { gte: since24h } } }),
    prisma.syncJob.count({ where: { shopId, status: 'done', createdAt: { gte: since24h } } }),
    prisma.changeLog.count({ where: { shopId, source: 'conflict_hold', createdAt: { gte: since7d } } }),
    prisma.product.count({ where: { shopId, shopifyDeletedAt: null, lastShopifySyncAt: null } }),
    prisma.product.count({ where: { shopId, shopifyDeletedAt: { not: null } } }),
    prisma.product.groupBy({ by: ['status'], where: { shopId, shopifyDeletedAt: null }, _count: true }),
    prisma.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(*)::bigint AS count FROM "Product"
      WHERE "shopId" = ${shopId}
        AND "shopifyDeletedAt" IS NULL
        AND "lastShopifySyncAt" IS NOT NULL
        AND "updatedAt" > "lastShopifySyncAt" + interval '1 second'
    `.then(([r]) => Number(r?.count ?? 0)).catch(() => 0),
    prisma.draft.count({ where: { shopId, entityType: 'product', userId: user?.id ?? '' } }),
    prisma.shop.findUnique({ where: { id: shopId }, select: { shopUrl: true } }),
    prisma.$queryRaw<Array<{ barcode: string; count: bigint; product_titles: string; products: string }>>`
      SELECT v.barcode, COUNT(*) as count,
        STRING_AGG(DISTINCT p.title, ', ' ORDER BY p.title) as product_titles,
        JSON_AGG(DISTINCT jsonb_build_object('id', p.id, 'title', p.title))::text as products
      FROM "Variant" v
      JOIN "Product" p ON p.id = v."productId"
      WHERE p."shopId" = ${shopId}
        AND p."shopifyDeletedAt" IS NULL
        AND v.barcode IS NOT NULL
        AND v.barcode != ''
      GROUP BY v.barcode
      HAVING COUNT(*) > 1
      ORDER BY count DESC
      LIMIT 20
    `.catch(() => [] as Array<{ barcode: string; count: bigint; product_titles: string; products: string }>),
    prisma.changeLog.findMany({
      where: { shopId, entityType: 'product' },
      orderBy: { createdAt: 'desc' },
      take: 60,
      select: {
        entityId: true,
        createdAt: true,
        source: true,
        user: { select: { firstName: true, lastName: true, email: true } },
      },
    }),
  ]);

  // Deduplicate changelog by entityId (keep most recent per product)
  const seenProductIds = new Set<string>();
  const distinctChanges: typeof recentChanges = [];
  for (const c of recentChanges) {
    if (!seenProductIds.has(c.entityId) && distinctChanges.length < 10) {
      seenProductIds.add(c.entityId);
      distinctChanges.push(c);
    }
  }

  const recentProductData = await prisma.product.findMany({
    where: { id: { in: distinctChanges.map((c) => c.entityId) } },
    select: { id: true, title: true, handle: true, updatedAt: true, lastShopifySyncAt: true, status: true },
  });
  const productMap = new Map(recentProductData.map((p) => [p.id, p]));

  const recentProducts = distinctChanges
    .map((c) => {
      const p = productMap.get(c.entityId);
      if (!p) return null;
      const changedByName = c.user
        ? [c.user.firstName, c.user.lastName].filter(Boolean).join(' ') || c.user.email || null
        : null;
      return {
        id: p.id,
        title: p.title,
        handle: p.handle,
        updatedAt: p.updatedAt.toISOString(),
        lastShopifySyncAt: p.lastShopifySyncAt?.toISOString() ?? null,
        status: p.status,
        lastChangedBy: changedByName,
        lastChangedSource: c.source,
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const isAdmin = ['platform_admin', 'platform_support'].includes(user?.platformRole ?? '');

  return {
    connected: true,
    shopUrl: shopRecord?.shopUrl ?? null,
    isAdmin,
    overview: {
      products,
      variants,
      collections,
      fields,
      mappings,
      fieldValues,
      productsNeverSynced,
      productsDeletedByShopify,
      productsPendingSync,
      productsDraft,
      productsByStatus: Object.fromEntries(productsByStatusRaw.map((r) => [r.status ?? 'UNKNOWN', r._count])) as Record<string, number>,
      duplicateEans: duplicateEansRaw.map((r) => {
        let products: Array<{ id: string; title: string }> = [];
        try { products = JSON.parse(r.products ?? '[]'); } catch { /* ignore */ }
        return { barcode: r.barcode, count: Number(r.count), productTitles: r.product_titles, products };
      }),
      aiUsage: {
        promptsAllTime: promptCountAll,
        prompts30d: promptCount30d,
        tokensAllTime: usageAll._sum.totalTokens ?? 0,
        tokens30d: usage30d._sum.totalTokens ?? 0,
        costDkkAllTime: usageAll._sum.estimatedCostDkk ?? 0,
        costDkk30d: usage30d._sum.estimatedCostDkk ?? 0,
      },
      sync: {
        queued,
        running,
        failed24h,
        done24h,
        conflictHolds7d,
      },
      recentProducts,
    },
  };
});

app.get('/shops/mapping-options', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  const shop = await prisma.shop.findUnique({ where: { id: user.shopId } });
  if (!shop) {
    return reply.code(404).send({ error: 'Shop not found' });
  }

  type MappingOption = {
    id: string;
    label: string;
    scope: 'product' | 'variant' | 'collection';
    targetType: string;
    targetJson: Record<string, unknown>;
  };

  const standardOptions: MappingOption[] = [
    { id: 'product.title', label: 'Produkt · Titel', scope: 'product', targetType: 'product_field', targetJson: { field: 'title' } },
    { id: 'product.handle', label: 'Produkt · Handle', scope: 'product', targetType: 'product_field', targetJson: { field: 'handle' } },
    { id: 'product.vendor', label: 'Produkt · Leverandør', scope: 'product', targetType: 'product_field', targetJson: { field: 'vendor' } },
    { id: 'product.productType', label: 'Produkt · Produkttype', scope: 'product', targetType: 'product_field', targetJson: { field: 'productType' } },
    { id: 'product.status', label: 'Produkt · Status', scope: 'product', targetType: 'product_field', targetJson: { field: 'status' } },
    { id: 'product.tags', label: 'Produkt · Tags', scope: 'product', targetType: 'product_field', targetJson: { field: 'tags' } },
    { id: 'product.descriptionHtml', label: 'Produkt · Beskrivelse (HTML)', scope: 'product', targetType: 'product_field', targetJson: { field: 'descriptionHtml' } },
    { id: 'product.seo.title', label: 'Produkt · SEO titel', scope: 'product', targetType: 'product_field', targetJson: { field: 'seo.title' } },
    { id: 'product.seo.description', label: 'Produkt · SEO beskrivelse', scope: 'product', targetType: 'product_field', targetJson: { field: 'seo.description' } },
    { id: 'collection.title', label: 'Kollektion · Titel', scope: 'collection', targetType: 'collection_field', targetJson: { field: 'title' } },
    { id: 'collection.handle', label: 'Kollektion · Handle', scope: 'collection', targetType: 'collection_field', targetJson: { field: 'handle' } },
    { id: 'collection.descriptionHtml', label: 'Kollektion · Beskrivelse (HTML)', scope: 'collection', targetType: 'collection_field', targetJson: { field: 'descriptionHtml' } },
    { id: 'variant.sku', label: 'Variant · SKU', scope: 'variant', targetType: 'variant_field', targetJson: { field: 'sku' } },
    { id: 'variant.barcode', label: 'Variant · Barcode', scope: 'variant', targetType: 'variant_field', targetJson: { field: 'barcode' } },
    { id: 'variant.price', label: 'Variant · Pris', scope: 'variant', targetType: 'variant_field', targetJson: { field: 'price' } },
    { id: 'variant.compareAtPrice', label: 'Variant · Sammenligningspris', scope: 'variant', targetType: 'variant_field', targetJson: { field: 'compareAtPrice' } },
    { id: 'variant.optionValues', label: 'Variant · Option values', scope: 'variant', targetType: 'variant_field', targetJson: { field: 'optionValues' } },
  ];

  type MetafieldDefinitionResponse = {
    metafieldDefinitions: {
      edges: Array<{
        node: {
          namespace: string;
          key: string;
          name: string;
          type: {
            name: string;
          };
        };
      }>;
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
    };
  };

  const fetchMetafieldDefinitions = async (
    client: ShopifyGraphQLClient,
    ownerType: 'PRODUCT' | 'PRODUCTVARIANT' | 'COLLECTION',
    scope: 'product' | 'variant' | 'collection',
  ): Promise<MappingOption[]> => {
    const output: MappingOption[] = [];
    let after: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const metafieldResponse: MetafieldDefinitionResponse = await client.execute<MetafieldDefinitionResponse>(
        `query MappingMetafieldDefinitions($ownerType: MetafieldOwnerType!, $after: String) {
          metafieldDefinitions(first: 100, ownerType: $ownerType, after: $after) {
            edges {
              node {
                namespace
                key
                name
                type {
                  name
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }`,
        { ownerType, after },
      );

      for (const edge of metafieldResponse.metafieldDefinitions.edges) {
        const node = edge.node;
        output.push({
          id: `${scope}.metafield.${node.namespace}.${node.key}`,
          label: `${scope === 'product' ? 'Produkt' : scope === 'variant' ? 'Variant' : 'Kollektion'} · Metafelt · ${node.name} (${node.namespace}.${node.key})`,
          scope,
          targetType: 'metafield',
          targetJson: {
            ownerType: scope,
            namespace: node.namespace,
            key: node.key,
            valueType: node.type.name,
          },
        });
      }

      hasNextPage = metafieldResponse.metafieldDefinitions.pageInfo.hasNextPage;
      after = metafieldResponse.metafieldDefinitions.pageInfo.endCursor;
    }

    return output;
  };

  const token = decryptSecret(shop.encryptedAdminToken, env.MASTER_ENCRYPTION_KEY);
  const client = new ShopifyGraphQLClient({
    storeUrl: shop.shopUrl,
    adminToken: token,
  });

  try {
    const [productMetafields, variantMetafields, collectionMetafields] = await Promise.all([
      fetchMetafieldDefinitions(client, 'PRODUCT', 'product'),
      fetchMetafieldDefinitions(client, 'PRODUCTVARIANT', 'variant'),
      fetchMetafieldDefinitions(client, 'COLLECTION', 'collection'),
    ]);

    return {
      options: [...standardOptions, ...productMetafields, ...variantMetafields, ...collectionMetafields],
      shopifyMetafieldsLoaded: true,
    };
  } catch (error) {
    request.log.warn({ error }, 'could not load Shopify metafield definitions for mapping options');
    return {
      options: standardOptions,
      shopifyMetafieldsLoaded: false,
      warning: 'Shopify metafield options could not be loaded. Check token permissions.',
    };
  }
});

app.post('/shops/sync-products', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  const shop = await prisma.shop.findUnique({ where: { id: user.shopId } });
  if (!shop) {
    return reply.code(404).send({ error: 'Shop not found' });
  }

  const autoMode = request.query?.auto === '1' || request.query?.auto === 'true';
  const initialMode = request.query?.initial === '1' || request.query?.initial === 'true';

  // Skip auto-sync for disconnected shops (e.g. demo shops)
  if (autoMode && shop.status === 'disconnected') {
    return reply.code(202).send({ skipped: true, reason: 'shop_disconnected' });
  }

  // After the first full pull has completed, auto-mode requests are skipped.
  // All subsequent product changes come through webhooks (PRODUCTS_CREATE/UPDATE/DELETE).
  if (autoMode && shop.initialSyncAt != null) {
    return reply.code(202).send({ skipped: true, reason: 'webhooks_active' });
  }

  const activePull = await prisma.syncJob.findFirst({
    where: {
      shopId: shop.id,
      type: 'shopify_pull_products',
      status: { in: ['queued', 'running'] },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (activePull) {
    // If the job has been stuck for more than 10 minutes, mark it failed and allow a new one.
    const staleThreshold = new Date(Date.now() - 10 * 60 * 1000);
    if (activePull.createdAt > staleThreshold) {
      return reply.code(202).send({ jobId: activePull.id, deduped: true });
    }
    await prisma.syncJob.update({
      where: { id: activePull.id },
      data: { status: 'failed', error: 'stale: exceeded 10-minute timeout without progress' },
    });
  }

  if (autoMode) {
    const activeOutbound = await prisma.syncJob.findFirst({
      where: {
        shopId: shop.id,
        status: { in: ['queued', 'running'] },
        type: { startsWith: 'outbound_' },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (activeOutbound) {
      return reply.code(202).send({ skipped: true, reason: 'outbound_sync_in_progress' });
    }
  }

  const token = decryptSecret(shop.encryptedAdminToken, env.MASTER_ENCRYPTION_KEY);
  const client = new ShopifyGraphQLClient({
    storeUrl: shop.shopUrl,
    adminToken: token,
  });

  type MappingIssue = {
    scope: 'product' | 'variant';
    namespace: string;
    key: string;
    typeHint: string;
    sampleValue?: string;
  };

  // Skip the mapping preflight on the very first sync — the user hasn't had a chance
  // to set up mappings yet. Only enforce it for shops that have already completed
  // an initial sync (shop.initialSyncAt is set) or when explicitly requested.
  const isFirstSync = shop.initialSyncAt == null;

  // Only run the metafield preflight check for shops that have already done an initial sync.
  // On the very first sync the user hasn't configured mappings yet, so we skip straight to execution.
  if (!isFirstSync) {
  const knownMappings = await prisma.mapping.findMany({
    where: {
      targetType: 'metafield',
      direction: { in: ['SHOPIFY_TO_PIM', 'TWO_WAY'] },
      fieldDefinition: { shopId: shop.id },
    },
    include: {
      fieldDefinition: {
        select: { scope: true },
      },
    },
  });

  const knownProductMetafields = new Set<string>();
  const knownVariantMetafields = new Set<string>();
  for (const mapping of knownMappings) {
    const target = (mapping.targetJson as { namespace?: string; key?: string } | null) ?? null;
    if (!target?.namespace || !target?.key) continue;
    const dedupeKey = `${target.namespace}:${target.key}`;
    if (mapping.fieldDefinition.scope === 'product') knownProductMetafields.add(dedupeKey);
    if (mapping.fieldDefinition.scope === 'variant') knownVariantMetafields.add(dedupeKey);
  }

  type PreflightResponse = {
    products: {
      nodes: Array<{
        metafields: { nodes: Array<{ namespace: string; key: string; type: string; value?: string | null }> };
        variants: {
          nodes: Array<{
            metafields: { nodes: Array<{ namespace: string; key: string; type: string; value?: string | null }> };
          }>;
        };
      }>;
    };
  };

  const preflight = await client.execute<PreflightResponse>(
    `query PreflightUnknownMetafields {
      products(first: 25) {
        nodes {
          metafields(first: 25) {
            nodes { namespace key type value }
          }
          variants(first: 10) {
            nodes {
              metafields(first: 25) {
                nodes { namespace key type value }
              }
            }
          }
        }
      }
    }`,
  );

  const mappingIssues = new Map<string, MappingIssue>();
  for (const productNode of preflight.products.nodes) {
    for (const metafield of productNode.metafields?.nodes ?? []) {
      const metafieldKey = `${metafield.namespace}:${metafield.key}`;
      if (!knownProductMetafields.has(metafieldKey)) {
        mappingIssues.set(`product:${metafieldKey}`, {
          scope: 'product',
          namespace: metafield.namespace,
          key: metafield.key,
          typeHint: metafield.type,
          sampleValue: (metafield.value ?? '').slice(0, 120),
        });
      }
    }

    for (const variantNode of productNode.variants?.nodes ?? []) {
      for (const metafield of variantNode.metafields?.nodes ?? []) {
        const metafieldKey = `${metafield.namespace}:${metafield.key}`;
        if (!knownVariantMetafields.has(metafieldKey)) {
          mappingIssues.set(`variant:${metafieldKey}`, {
            scope: 'variant',
            namespace: metafield.namespace,
            key: metafield.key,
            typeHint: metafield.type,
            sampleValue: (metafield.value ?? '').slice(0, 120),
          });
        }
      }
    }
  }

  if (mappingIssues.size > 0) {
    return reply.code(409).send({
      error: 'mapping_required',
      message: 'Ukendte Shopify-metafields kræver mapping før synkronisering kan fortsætte.',
      issues: Array.from(mappingIssues.values()),
    });
  }
  } // end if (!isFirstSync)

  const syncJob = await prisma.syncJob.create({
    data: {
      shopId: shop.id,
      type: 'shopify_pull_products',
      status: 'queued',
      payloadJson: {
        phase: 'queued',
        processedProducts: 0,
        processedVariants: 0,
      },
    },
  });

  type SyncProductsResponse = {
    products: {
      edges: Array<{
        cursor: string;
        node: {
          id: string;
          title: string;
          handle: string;
          vendor?: string | null;
          productType?: string | null;
          status?: string | null;
          publishedAt?: string | null;
          totalInventory?: number | null;
          descriptionHtml?: string | null;
          tags?: string[];
          seo?: { title?: string | null; description?: string | null } | null;
          featuredImage?: { url: string; altText?: string | null } | null;
          images?: { edges: Array<{ node: { url: string; altText?: string | null } }> };
          collections?: {
            nodes: Array<{
              id: string;
              title: string;
              handle: string;
              descriptionHtml?: string | null;
            }>;
          };
          variants: {
            edges: Array<{
              node: {
                id: string;
                sku?: string | null;
                barcode?: string | null;
                price?: string | null;
                compareAtPrice?: string | null;
                taxable?: boolean | null;
                inventoryPolicy?: string | null;
                inventoryItem?: { tracked?: boolean; requiresShipping?: boolean | null; measurement?: { weight?: { value?: number | null; unit?: string | null } | null } | null } | null;
                selectedOptions?: Array<{ name: string; value: string }>;
              };
            }>;
            pageInfo: {
              hasNextPage: boolean;
              endCursor: string | null;
            };
          };
        };
      }>;
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
    };
  };

  type ShopifyVariantNode = {
    id: string;
    sku?: string | null;
    barcode?: string | null;
    price?: string | null;
    compareAtPrice?: string | null;
    taxable?: boolean | null;
    inventoryPolicy?: string | null;
    inventoryItem?: { tracked?: boolean; requiresShipping?: boolean | null; measurement?: { weight?: { value?: number | null; unit?: string | null } | null } | null } | null;
    selectedOptions?: Array<{ name: string; value: string }>;
  };

  type ProductVariantsResponse = {
    product: {
      variants: {
        edges: Array<{ node: ShopifyVariantNode }>;
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
      };
    } | null;
  };

  const fetchAllVariantsForProduct = async (
    productGid: string,
    initialVariants: SyncProductsResponse['products']['edges'][number]['node']['variants'],
  ): Promise<ShopifyVariantNode[]> => {
    const collected = initialVariants.edges.map((edge) => edge.node);
    let hasNext = initialVariants.pageInfo.hasNextPage;
    let afterCursor = initialVariants.pageInfo.endCursor;

    while (hasNext) {
      const response = await client.execute<ProductVariantsResponse>(
        `query ProductVariants($id: ID!, $after: String) {
          product(id: $id) {
            variants(first: 250, after: $after) {
              edges {
                node {
                  id
                  sku
                  barcode
                  price
                  compareAtPrice
                  taxable
                  inventoryPolicy
                  inventoryItem {
                    tracked
                    requiresShipping
                    measurement { weight { value unit } }
                  }
                  selectedOptions {
                    name
                    value
                  }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }`,
        { id: productGid, after: afterCursor },
      );

      const variants = response.product?.variants;
      if (!variants) {
        break;
      }

      for (const edge of variants.edges) {
        collected.push(edge.node);
      }

      hasNext = variants.pageInfo.hasNextPage;
      afterCursor = variants.pageInfo.endCursor;
    }

    return collected;
  };

  const runSyncInBackground = async (): Promise<void> => {
    let productsImported = 0;
    let variantsImported = 0;
    let productsCreated = 0;
    let productsUpdated = 0;
    let productsMatched = 0;
    let variantsCreated = 0;
    let variantsUpdated = 0;
    let variantsMatched = 0;

    let hasNextPage = true;
    let after: string | null = null;

    try {
      await prisma.syncJob.update({
        where: { id: syncJob.id },
        data: {
          status: 'running',
          payloadJson: {
            phase: 'running',
            processedProducts: 0,
            processedVariants: 0,
          },
        },
      });

      while (hasNextPage) {
        const syncResponse: SyncProductsResponse = await client.execute<SyncProductsResponse>(
      `query SyncProducts($after: String) {
        products(first: 250, after: $after, sortKey: CREATED_AT, reverse: false) {
          edges {
            cursor
            node {
              id
              title
              handle
              vendor
              productType
              status
              publishedAt
              totalInventory
              descriptionHtml
              tags
              seo { title description }
              featuredImage { url altText }
              images(first: 20) { edges { node { url altText } } }
              collections(first: 50) {
                nodes {
                  id
                  title
                  handle
                  descriptionHtml
                }
              }
              variants(first: 250) {
                edges {
                  node {
                    id
                    sku
                    barcode
                    price
                    compareAtPrice
                    taxable
                    inventoryPolicy
                    inventoryItem {
                      tracked
                      requiresShipping
                      measurement { weight { value unit } }
                    }
                    selectedOptions {
                      name
                      value
                    }
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }`,
      { after },
    );

        for (const edge of syncResponse.products.edges) {
          const node = edge.node;
          const commonProductData = {
            shopId: shop.id,
            title: node.title,
            handle: node.handle,
            vendor: node.vendor ?? undefined,
            productType: node.productType ?? undefined,
            status: node.status ?? undefined,
            publishedAt: node.publishedAt ? new Date(node.publishedAt as string) : null,
            descriptionHtml: node.descriptionHtml ?? undefined,
            tagsJson: node.tags ?? [],
            seoJson: { title: node.seo?.title ?? null, description: node.seo?.description ?? null },
            imagesJson: (node.images?.edges ?? []).map((e: any) => ({ url: e.node.url, altText: e.node.altText })),
            lastShopifySyncAt: new Date(),
          };

          let product = await prisma.product.findUnique({ where: { shopifyProductGid: node.id } });

          if (product) {
            const locallyChangedAfterLastSync =
              product.lastShopifySyncAt && product.updatedAt.getTime() > product.lastShopifySyncAt.getTime() + 1000;

            if (locallyChangedAfterLastSync) {
              await prisma.changeLog.create({
                data: {
                  shopId: shop.id,
                  entityType: 'product',
                  entityId: product.id,
                  source: 'conflict_hold',
                  afterJson: {
                    reason: 'local_changes_detected',
                    incoming: {
                      title: node.title,
                      handle: node.handle,
                    },
                  },
                  jobId: syncJob.id,
                },
              });
              continue;
            }

            product = await prisma.product.update({
              where: { id: product.id },
              data: commonProductData,
            });
            productsUpdated += 1;
          } else {
            const matchedProduct = await prisma.product.findFirst({
              where: {
                shopId: shop.id,
                handle: node.handle,
              },
            });

            if (matchedProduct) {
              product = await prisma.product.update({
                where: { id: matchedProduct.id },
                data: {
                  ...commonProductData,
                  shopifyProductGid: node.id,
                },
              });
              productsMatched += 1;
            } else {
              product = await prisma.product.create({
                data: {
                  ...commonProductData,
                  shopifyProductGid: node.id,
                },
              });
              productsCreated += 1;
            }
          }

          productsImported += 1;

          const incomingCollections = node.collections?.nodes ?? [];
          const localCollections: Array<{ id: string }> = [];
          for (const collectionNode of incomingCollections) {
            const local = await prisma.collection.upsert({
              where: { shopifyCollectionGid: collectionNode.id },
              create: {
                shopId: shop.id,
                shopifyCollectionGid: collectionNode.id,
                title: collectionNode.title,
                handle: collectionNode.handle,
                descriptionHtml: collectionNode.descriptionHtml ?? null,
                lastShopifySyncAt: new Date(),
              },
              update: {
                title: collectionNode.title,
                handle: collectionNode.handle,
                descriptionHtml: collectionNode.descriptionHtml ?? null,
                lastShopifySyncAt: new Date(),
              },
              select: { id: true },
            });
            localCollections.push(local);
          }

          if (await hasProductCollectionTable()) {
            await prisma.productCollection.deleteMany({ where: { productId: product.id } });
            if (localCollections.length > 0) {
              await prisma.productCollection.createMany({
                data: localCollections.map((collectionItem) => ({
                  productId: product.id,
                  collectionId: collectionItem.id,
                  shopId: shop.id,
                })),
                skipDuplicates: true,
              });
            }
          }

          const allVariantNodes = await fetchAllVariantsForProduct(node.id, node.variants);

          const existingVariants = await prisma.variant.findMany({
            where: {
              productId: product.id,
            },
          });

          const existingByGid = new Map(existingVariants.filter((item) => item.shopifyVariantGid).map((item) => [item.shopifyVariantGid as string, item]));
          const existingBySku = new Map(existingVariants.filter((item) => item.sku).map((item) => [item.sku as string, item]));
          const existingByBarcode = new Map(existingVariants.filter((item) => item.barcode).map((item) => [item.barcode as string, item]));

          for (const variantNode of allVariantNodes) {
            const optionValues = (variantNode.selectedOptions ?? []).map((option: { value: string }) => option.value);
            const inventoryQty: number | undefined = undefined; // quantities not fetched during full sync
            const commonVariantData = {
              productId: product.id,
              sku: variantNode.sku ?? undefined,
              barcode: variantNode.barcode ?? undefined,
              price: variantNode.price ?? undefined,
              compareAtPrice: variantNode.compareAtPrice ?? undefined,
              optionValuesJson: optionValues,
              weight: variantNode.inventoryItem?.measurement?.weight?.value ?? undefined,
              weightUnit: variantNode.inventoryItem?.measurement?.weight?.unit ?? undefined,
              requiresShipping: variantNode.inventoryItem?.requiresShipping ?? undefined,
              taxable: variantNode.taxable ?? undefined,
              inventoryPolicy: variantNode.inventoryPolicy ?? undefined,
              inventoryQuantity: inventoryQty,
              lastShopifySyncAt: new Date(),
            };

            const existingVariant = existingByGid.get(variantNode.id);
            if (existingVariant) {
              const locallyChangedAfterLastSync =
                existingVariant.lastShopifySyncAt && existingVariant.updatedAt.getTime() > existingVariant.lastShopifySyncAt.getTime() + 1000;

              if (locallyChangedAfterLastSync) {
                await prisma.changeLog.create({
                  data: {
                    shopId: shop.id,
                    entityType: 'variant',
                    entityId: existingVariant.id,
                    source: 'conflict_hold',
                    afterJson: {
                      reason: 'local_changes_detected',
                      incoming: {
                        sku: variantNode.sku,
                        barcode: variantNode.barcode,
                        price: variantNode.price,
                      },
                    },
                    jobId: syncJob.id,
                  },
                });
                variantsImported += 1;
                continue;
              }

              await prisma.variant.update({
                where: { id: existingVariant.id },
                data: commonVariantData,
              });
              variantsUpdated += 1;
              variantsImported += 1;
              continue;
            }

            const matchedVariant =
              (variantNode.sku ? existingBySku.get(variantNode.sku) : null) ??
              (variantNode.barcode ? existingByBarcode.get(variantNode.barcode) : null) ??
              null;

            if (matchedVariant) {
              await prisma.variant.update({
                where: { id: matchedVariant.id },
                data: {
                  ...commonVariantData,
                  shopifyVariantGid: variantNode.id,
                },
              });
              variantsMatched += 1;
            } else {
              const createdVariant = await prisma.variant.create({
                data: {
                  ...commonVariantData,
                  shopifyVariantGid: variantNode.id,
                },
              });
              existingByGid.set(variantNode.id, createdVariant);
              if (createdVariant.sku) {
                existingBySku.set(createdVariant.sku, createdVariant);
              }
              if (createdVariant.barcode) {
                existingByBarcode.set(createdVariant.barcode, createdVariant);
              }
              variantsCreated += 1;
            }

            variantsImported += 1;
          }

          if (productsImported % 20 === 0) {
            await prisma.syncJob.update({
              where: { id: syncJob.id },
              data: {
                payloadJson: {
                  phase: 'running',
                  processedProducts: productsImported,
                  processedVariants: variantsImported,
                },
              },
            });
          }
        }

        hasNextPage = syncResponse.products.pageInfo.hasNextPage;
        after = syncResponse.products.pageInfo.endCursor;
      }

      await prisma.syncJob.update({
        where: { id: syncJob.id },
        data: {
          status: 'done',
          finishedAt: new Date(),
          payloadJson: {
            phase: 'done',
            productsImported,
            variantsImported,
            productsCreated,
            productsUpdated,
            productsMatched,
            variantsCreated,
            variantsUpdated,
            variantsMatched,
          },
        },
      });

      // Mark the shop's initial sync as completed — future auto-mode calls will be skipped.
      if (!shop.initialSyncAt) {
        await prisma.shop.update({ where: { id: shop.id }, data: { initialSyncAt: new Date() } });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown sync error';
      await prisma.syncJob.update({
        where: { id: syncJob.id },
        data: {
          status: 'failed',
          error: message,
          finishedAt: new Date(),
        },
      });
    }
  };

  void runSyncInBackground();

  return reply.code(202).send({ jobId: syncJob.id });
});

app.get('/fields', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }
  const user = await getCurrentUser(request);
  const shopId = await resolveShopIdForPlatformAdmin(request, user);
  if (shopId) {
    await ensureBuiltInFields(shopId);
  }
  const fields = await prisma.fieldDefinition.findMany({
    where: { shopId: shopId ?? '' },
    include: { mapping: true },
    orderBy: [{ isBuiltIn: 'desc' }, { createdAt: 'asc' }],
  });

  const valueGroups = await prisma.fieldValue.groupBy({
    by: ['fieldDefinitionId', 'ownerType', 'ownerId'],
    where: {
      fieldDefinitionId: { in: fields.map((field) => field.id) },
      ownerType: 'product',
    },
  });

  const usageCountByField = valueGroups.reduce<Record<string, number>>((acc, group) => {
    acc[group.fieldDefinitionId] = (acc[group.fieldDefinitionId] ?? 0) + 1;
    return acc;
  }, {});

  return {
    fields: fields.map((field) => ({
      ...field,
      mapped: Boolean(field.mapping),
      productValueCount: usageCountByField[field.id] ?? 0,
    })),
  };
});

app.post('/fields', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }
  const parsed = fieldDefinitionSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }
  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  const field = await prisma.fieldDefinition.create({
    data: {
      shopId: user.shopId,
      ...parsed.data,
    },
  });
  return reply.code(201).send({ field });
});

app.patch('/fields/:id', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) {
    return;
  }
  const parsed = fieldDefinitionSchema.partial().safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }
  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  const existingField = await prisma.fieldDefinition.findFirst({
    where: { id: request.params.id, shopId: user.shopId },
  });
  if (!existingField) {
    return reply.code(404).send({ error: 'Field not found' });
  }

  const field = await prisma.fieldDefinition.update({ where: { id: existingField.id }, data: parsed.data });
  return { field };
});

app.patch('/fields/:id/lock', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) {
    return;
  }
  const parsed = z.object({ lockLevel: z.enum(['none', 'users', 'all']) }).safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }
  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }
  // Only owners and platform admins can lock/unlock
  const isAdmin = user.role === 'owner' || user.platformRole === 'platform_admin' || user.platformRole === 'platform_support';
  if (!isAdmin) {
    return reply.code(403).send({ error: 'Only shop owners can lock or unlock fields' });
  }
  const field = await prisma.fieldDefinition.findFirst({
    where: { id: request.params.id, shopId: user.shopId },
  });
  if (!field) {
    return reply.code(404).send({ error: 'Field not found' });
  }
  const updated = await prisma.fieldDefinition.update({
    where: { id: field.id },
    data: { lockLevel: parsed.data.lockLevel },
  });
  return { field: updated };
});

app.delete('/fields/:id', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) {
    return;
  }
  const parsed = deleteFieldSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }

  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  const field = await prisma.fieldDefinition.findFirst({ where: { id: request.params.id, shopId: user.shopId } });
  if (!field) {
    return reply.code(404).send({ error: 'Field not found' });
  }

  if (field.isBuiltIn) {
    return reply.code(400).send({ error: 'Systemfelter kan ikke slettes.' });
  }

  if (parsed.data.confirmText.trim() !== field.key) {
    return reply.code(400).send({ error: `Confirmation text must match field key: ${field.key}` });
  }

  await prisma.$transaction([
    prisma.mapping.deleteMany({ where: { fieldDefinitionId: field.id } }),
    prisma.fieldValue.deleteMany({ where: { fieldDefinitionId: field.id } }),
    prisma.fieldDefinition.delete({ where: { id: field.id } }),
  ]);

  return { ok: true };
});

app.get('/products/:id/resource-usage', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  const product = await prisma.product.findUnique({ where: { id: request.params.id } });
  if (!product) {
    return reply.code(404).send({ error: 'Product not found' });
  }
  if (product.shopId !== user.shopId) {
    return reply.code(403).send({ error: 'Forbidden product access' });
  }

  const usages = await prisma.aiUsage.findMany({
    where: { productId: product.id },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  const totals = usages.reduce(
    (acc, usage) => {
      acc.promptTokens += usage.promptTokens;
      acc.completionTokens += usage.completionTokens;
      acc.totalTokens += usage.totalTokens;
      acc.estimatedCostDkk += usage.estimatedCostDkk;
      acc.estimatedCostUsd += usage.estimatedCostUsd;
      return acc;
    },
    { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostDkk: 0, estimatedCostUsd: 0 },
  );

  return { usages, totals };
});

app.get('/prompts', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }
  const user = await getCurrentUser(request);
  const shopId = await resolveShopIdForPlatformAdmin(request, user);
  const prompts = await prisma.promptTemplate.findMany({
    where: { shopId: shopId ?? '' },
    orderBy: [{ category: 'asc' }, { updatedAt: 'desc' }],
  });
  return { prompts };
});

app.post('/prompts', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }
  const parsed = promptTemplateSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }
  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }
  const prompt = await prisma.promptTemplate.create({
    data: {
      shopId: user.shopId,
      ...parsed.data,
    },
  });
  return reply.code(201).send({ prompt });
});

app.patch('/prompts/:id', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }
  const parsed = promptTemplateSchema.partial().safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }

  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  const existingPrompt = await prisma.promptTemplate.findFirst({ where: { id: request.params.id, shopId: user.shopId } });
  if (!existingPrompt) {
    return reply.code(404).send({ error: 'Prompt not found' });
  }

  const prompt = await prisma.promptTemplate.update({ where: { id: existingPrompt.id }, data: parsed.data });
  return { prompt };
});

app.delete('/prompts/:id', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  const deleted = await prisma.promptTemplate.deleteMany({ where: { id: request.params.id, shopId: user.shopId } });
  if (deleted.count === 0) {
    return reply.code(404).send({ error: 'Prompt not found' });
  }

  return { ok: true };
});

app.post('/sources', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const parsed = sourceCreateSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }

  const shopId = resolveActiveShopId(request, user);
  if (!shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }
  if (!(await ensureShopAccess({ user, shopId }))) {
    return reply.code(403).send({ error: 'No access to this shop' });
  }

  const isLiveLookup = parsed.data.type === 'live_lookup';
  const type = isLiveLookup ? 'live_lookup' : parsed.data.type === 'web' ? 'web' : parsed.data.type === 'products' ? 'products' : 'product_feed';
  const feedType = isLiveLookup ? undefined : (parsed.data.feedType ?? (type === 'web' ? 'live_url' : type === 'products' ? 'static_file' : 'live_url'));
  const url = parsed.data.url?.trim() ?? '';
  const csv = parsed.data.csv?.trim() ?? '';

  if (isLiveLookup) {
    if (!url) return reply.code(400).send({ error: 'URL-skabelon er påkrævet for live lookup-kilder' });
  } else if (feedType === 'live_url') {
    const validUrl = z.string().url().safeParse(url);
    if (!validUrl.success) {
      return reply.code(400).send({ error: 'Valid URL is required for live URL feeds' });
    }
  }

  if (!isLiveLookup && feedType === 'static_file' && !csv) {
    return reply.code(400).send({ error: 'CSV file content is required for static file feeds' });
  }

  const fallbackFileName = parsed.data.fileName?.trim() || `${parsed.data.name.replace(/\s+/g, '-').toLowerCase()}.csv`;
  const persistedUrl = isLiveLookup ? url : feedType === 'live_url' ? url : `file://${fallbackFileName}`;

  const source = await prisma.source.create({
    data: {
      shopId,
      name: parsed.data.name,
      url: persistedUrl,
      active: parsed.data.active,
      tagsJson: buildSourceTagsJson({
        type: isLiveLookup ? 'live_lookup' : 'product_feed',
        feedType: isLiveLookup ? undefined : feedType,
        scope: parsed.data.scope ?? 'products',
        crawlFrequency: !isLiveLookup && feedType === 'live_url' ? (parsed.data.crawlFrequency ?? 'weekly') : undefined,
        promptTemplate: parsed.data.promptTemplate,
        tags: parsed.data.tagsJson,
        ...(!isLiveLookup && feedType === 'static_file'
          ? { fileName: fallbackFileName, csv }
          : {}),
      }) as any,
    },
  });

  return reply.code(201).send({ source: normalizeSourceDto(source) });
});

app.get('/sources', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }
  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }
  const shopId = await resolveShopIdForPlatformAdmin(request, user);
  if (!shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }
  if (!(await ensureShopAccess({ user, shopId }))) {
    return reply.code(403).send({ error: 'No access to this shop' });
  }
  const sources = await prisma.source.findMany({ where: { shopId }, orderBy: { updatedAt: 'desc' } });
  return { sources: sources.map((source) => normalizeSourceDto(source)) };
});

app.patch('/sources/:id', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }
  const parsed = sourcePatchSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }
  const shopId = resolveActiveShopId(request, user);
  if (!shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }
  if (!(await ensureShopAccess({ user, shopId }))) {
    return reply.code(403).send({ error: 'No access to this shop' });
  }

  const existing = await prisma.source.findFirst({ where: { id: request.params.id, shopId } });
  if (!existing) {
    return reply.code(404).send({ error: 'Source not found' });
  }

  const existingMeta = readSourceMeta(existing.tagsJson);
  const nextFeedType = parsed.data.feedType ?? existingMeta.feedType ?? (existingMeta.type === 'products' ? 'static_file' : 'live_url');
  const nextTags = parsed.data.tagsJson ?? existingMeta.tags;
  const nextCsv = parsed.data.csv ?? existingMeta.csv;
  const requestedFileName = parsed.data.fileName ?? existingMeta.fileName ?? '';
  const nextFileName = requestedFileName.trim() || `${(parsed.data.name ?? existing.name).replace(/\s+/g, '-').toLowerCase()}.csv`;
  const requestedUrl = parsed.data.url?.trim();
  const nextUrl = nextFeedType === 'live_url' ? requestedUrl ?? existing.url : `file://${nextFileName}`;

  if (nextFeedType === 'live_url') {
    const validUrl = z.string().url().safeParse(nextUrl);
    if (!validUrl.success) {
      return reply.code(400).send({ error: 'Valid URL is required for live URL feeds' });
    }
  }

  if (nextFeedType === 'static_file' && (!nextCsv || !nextCsv.trim())) {
    return reply.code(400).send({ error: 'CSV file content is required for static file feeds' });
  }

  const source = await prisma.source.update({
    where: { id: request.params.id, shopId },
    data: {
      ...(parsed.data.name ? { name: parsed.data.name } : {}),
      ...(typeof parsed.data.active === 'boolean' ? { active: parsed.data.active } : {}),
      url: nextUrl,
      tagsJson: buildSourceTagsJson({
        type: 'product_feed',
        feedType: nextFeedType,
        scope: parsed.data.scope ?? existingMeta.scope ?? 'products',
        crawlFrequency: nextFeedType === 'live_url' ? (parsed.data.crawlFrequency ?? existingMeta.crawlFrequency ?? 'weekly') : undefined,
        promptTemplate: parsed.data.promptTemplate ?? existingMeta.promptTemplate,
        tags: nextTags,
        ...(nextFeedType === 'static_file'
          ? {
              fileName: nextFileName,
              csv: nextCsv,
            }
          : {}),
        ...(existingMeta.lastScanAt ? { lastScanAt: existingMeta.lastScanAt } : {}),
        ...(existingMeta.lastCrawlAt ? { lastCrawlAt: existingMeta.lastCrawlAt } : {}),
      }) as any,
    },
  });

  return { source: normalizeSourceDto(source) };
});

app.post('/sources/:id/scan-products', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }
  const shopId = resolveActiveShopId(request, user);
  if (!shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }
  if (!(await ensureShopAccess({ user, shopId }))) {
    return reply.code(403).send({ error: 'No access to this shop' });
  }

  const source = await prisma.source.findFirst({ where: { id: request.params.id, shopId } });
  if (!source) {
    return reply.code(404).send({ error: 'Source not found' });
  }

  const meta = readSourceMeta(source.tagsJson);
  if (meta.type !== 'products') {
    return reply.code(400).send({ error: 'Only product sources can be scanned to products' });
  }

  if (!meta.csv || !meta.csv.trim()) {
    return reply.code(400).send({ error: 'Source has no CSV file content' });
  }

  const products = await prisma.product.findMany({ where: { shopId }, include: { variants: true } });
  const scan = buildSourceProductScan(meta.csv, products);

  await prisma.source.update({
    where: { id: source.id, shopId },
    data: {
      tagsJson: buildSourceTagsJson({
        ...meta,
        lastScanAt: new Date().toISOString(),
      }) as any,
    },
  });

  const sampleRows = scan.matches.slice(0, 3).map((m) => m.rowData);
  const sampleValues: Record<string, string[]> = {};
  for (const header of scan.headers) {
    sampleValues[header] = sampleRows.map((r) => r[header] ?? '').filter(Boolean).slice(0, 3);
  }

  return {
    summary: {
      totalRows: scan.totalRows,
      matchedRows: scan.matches.length,
      unmatchedRows: scan.unmatched.length,
    },
    headers: scan.headers,
    sampleValues,
    existingFieldMappings: meta.fieldMappings ?? [],
    matches: scan.matches.slice(0, 100).map((item) => ({
      row: item.row,
      matchBy: item.matchBy,
      productId: item.productId,
      productTitle: item.productTitle,
      rowValues: item.rowValues,
    })),
    unmatched: scan.unmatched.slice(0, 100),
  };
});

app.patch('/sources/:id/field-mappings', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const parsed = z
    .object({
      fieldMappings: z.array(
        z.object({ csvColumn: z.string().min(1), fieldDefinitionId: z.string().cuid() }),
      ),
    })
    .safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }
  const shopId = resolveActiveShopId(request, user);
  if (!shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }
  if (!(await ensureShopAccess({ user, shopId }))) {
    return reply.code(403).send({ error: 'No access to this shop' });
  }

  const source = await prisma.source.findFirst({ where: { id: request.params.id, shopId } });
  if (!source) {
    return reply.code(404).send({ error: 'Source not found' });
  }

  const fieldDefIds = parsed.data.fieldMappings.map((m) => m.fieldDefinitionId);
  const validFields = await prisma.fieldDefinition.findMany({
    where: { id: { in: fieldDefIds }, shopId },
    select: { id: true },
  });
  const validFieldIds = new Set(validFields.map((f) => f.id));
  const validMappings = parsed.data.fieldMappings.filter((m) => validFieldIds.has(m.fieldDefinitionId));

  const meta = readSourceMeta(source.tagsJson);
  const updated = await prisma.source.update({
    where: { id: source.id, shopId },
    data: {
      tagsJson: buildSourceTagsJson({ ...meta, fieldMappings: validMappings }) as any,
    },
  });

  return { source: normalizeSourceDto(updated) };
});

app.post('/sources/:id/apply-products', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const parsed = sourceApplyProductsSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }
  const shopId = resolveActiveShopId(request, user);
  if (!shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }
  if (!(await ensureShopAccess({ user, shopId }))) {
    return reply.code(403).send({ error: 'No access to this shop' });
  }

  const source = await prisma.source.findFirst({ where: { id: request.params.id, shopId } });
  if (!source) {
    return reply.code(404).send({ error: 'Source not found' });
  }

  const meta = readSourceMeta(source.tagsJson);
  if (meta.type !== 'products') {
    return reply.code(400).send({ error: 'Only product sources can be applied to products' });
  }

  if (!meta.csv || !meta.csv.trim()) {
    return reply.code(400).send({ error: 'Source has no CSV file content' });
  }

  const products = await prisma.product.findMany({ where: { shopId }, include: { variants: true } });
  const scan = buildSourceProductScan(meta.csv, products);

  const syncJobIds: string[] = [];
  let updatedRows = 0;
  let skippedNoChanges = 0;

  for (const match of scan.matches) {
    const incomingTitle = pickFirstCell(match.rowData, ['title', 'name', 'producttitle', 'produktnavn']);
    const incomingHandle = pickFirstCell(match.rowData, ['handle', 'producthandle']);
    const incomingVendor = pickFirstCell(match.rowData, ['vendor', 'supplier', 'brand', 'leverandor', 'leverandør']);
    const incomingProductType = pickFirstCell(match.rowData, ['producttype', 'type', 'kategori', 'category']);
    const incomingStatus = pickFirstCell(match.rowData, ['status', 'productstatus']);
    const incomingDescriptionHtml = pickFirstCell(match.rowData, ['descriptionhtml', 'description', 'beskrivelse', 'bodyhtml']);
    const incomingTagsRaw = pickFirstCell(match.rowData, ['tags', 'tag', 'producttags', 'produkttags']);
    const incomingTags = incomingTagsRaw
      ? incomingTagsRaw
          .split(/[;,|]/)
          .map((tag) => tag.trim())
          .filter(Boolean)
      : undefined;

    const updateData: Record<string, unknown> = {};

    if (incomingTitle && incomingTitle !== match.product.title) {
      updateData.title = incomingTitle;
    }

    if (incomingHandle && incomingHandle !== match.product.handle) {
      updateData.handle = incomingHandle;
    }

    if (incomingVendor && incomingVendor !== (match.product.vendor ?? '')) {
      updateData.vendor = incomingVendor;
    }

    if (incomingProductType && incomingProductType !== (match.product.productType ?? '')) {
      updateData.productType = incomingProductType;
    }

    if (incomingStatus && incomingStatus !== (match.product.status ?? '')) {
      updateData.status = incomingStatus;
    }

    if (incomingDescriptionHtml && incomingDescriptionHtml !== (match.product.descriptionHtml ?? '')) {
      updateData.descriptionHtml = incomingDescriptionHtml;
    }

    if (incomingTags && JSON.stringify(incomingTags) !== JSON.stringify((match.product.tagsJson as unknown[] | null) ?? [])) {
      updateData.tagsJson = incomingTags;
    }

    if (!Object.keys(updateData).length) {
      skippedNoChanges += 1;
      continue;
    }

    const updated = await prisma.product.update({
      where: { id: match.product.id },
      data: updateData,
    });

    await createSnapshotAndLog({
      shopId: updated.shopId,
      entityType: 'product',
      entityId: updated.id,
      reason: 'source_products_apply',
      beforeJson: match.product,
      afterJson: updated,
      source: 'supplier_file',
      userId: request.user.id,
    });

    if (parsed.data.syncNow) {
      const syncJob = await prisma.syncJob.create({
        data: {
          shopId: updated.shopId,
          type: 'outbound_product_patch',
          payloadJson: { productId: updated.id, patch: updateData } as any,
        },
      });
      await syncQueue.add('outbound-product', { syncJobId: syncJob.id }, { jobId: syncJob.id });
      syncJobIds.push(syncJob.id);
    }

    updatedRows += 1;
  }

  // Apply custom FieldDefinition values via fieldMappings
  let fieldValueRows = 0;
  if (meta.fieldMappings && meta.fieldMappings.length > 0) {
    const fieldMappings = meta.fieldMappings;

    for (const match of scan.matches) {
      for (const mapping of fieldMappings) {
        const colValue = (match.rowData[normalizeHeader(mapping.csvColumn)] ?? '').trim();
        if (!colValue) {
          continue;
        }

        const fieldDef = await prisma.fieldDefinition.findFirst({
          where: { id: mapping.fieldDefinitionId, shopId },
          select: { id: true },
        });
        if (!fieldDef) {
          continue;
        }

        const relationIds = { productId: match.productId, variantId: null };

        await prisma.fieldValue.upsert({
          where: {
            ownerType_ownerId_fieldDefinitionId: {
              ownerType: 'product',
              ownerId: match.productId,
              fieldDefinitionId: fieldDef.id,
            },
          },
          update: {
            valueJson: colValue,
            source: 'import',
            updatedByUserId: request.user.id,
          },
          create: {
            ownerType: 'product',
            ownerId: match.productId,
            productId: relationIds.productId,
            variantId: null,
            fieldDefinitionId: fieldDef.id,
            valueJson: colValue,
            source: 'import',
            updatedByUserId: request.user.id,
          },
        });

        fieldValueRows += 1;
      }
    }
  }

  await prisma.source.update({
    where: { id: source.id },
    data: {
      tagsJson: buildSourceTagsJson({
        ...meta,
        lastScanAt: new Date().toISOString(),
      }) as any,
    },
  });

  return {
    summary: {
      totalRows: scan.totalRows,
      matchedRows: scan.matches.length,
      unmatchedRows: scan.unmatched.length,
      updatedRows,
      skippedNoChanges,
      syncJobsQueued: syncJobIds.length,
      fieldValueRows,
    },
    syncJobIds,
    updatedSample: scan.matches.slice(0, 20).map((item) => ({
      row: item.row,
      productId: item.productId,
      productTitle: item.productTitle,
      matchBy: item.matchBy,
    })),
  };
});

app.delete('/sources/:id', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }
  const shopId = resolveActiveShopId(request, user);
  if (!shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }
  if (!(await ensureShopAccess({ user, shopId }))) {
    return reply.code(403).send({ error: 'No access to this shop' });
  }

  const deleted = await prisma.source.deleteMany({ where: { id: request.params.id, shopId } });
  if (deleted.count === 0) {
    return reply.code(404).send({ error: 'Source not found' });
  }

  return { ok: true };
});

app.post('/sources/:id/crawl', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }
  const shopId = resolveActiveShopId(request, user);
  if (!shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }
  if (!(await ensureShopAccess({ user, shopId }))) {
    return reply.code(403).send({ error: 'No access to this shop' });
  }

  const source = await prisma.source.findFirst({ where: { id: request.params.id, shopId } });
  if (!source) {
    return reply.code(404).send({ error: 'Source not found' });
  }

  const meta = readSourceMeta(source.tagsJson);
  if (meta.feedType !== 'live_url' && meta.type !== 'web') {
    return reply.code(400).send({ error: 'Only live URL sources can be crawled' });
  }

  if (!source.url || !source.url.startsWith('http')) {
    return reply.code(400).send({ error: 'Source has no valid URL' });
  }

  // Mark source as crawling
  await prisma.source.update({
    where: { id: source.id },
    data: {
      tagsJson: buildSourceTagsJson({
        ...meta,
        crawlStatus: 'crawling',
        crawlStartedAt: new Date().toISOString(),
        crawlError: undefined,
      }) as any,
    },
  });

  const job = await feedCrawlQueue.add(
    'crawl',
    { sourceId: source.id },
    { jobId: `manual-crawl-${source.id}-${Date.now()}`, removeOnComplete: 50, removeOnFail: 20 },
  );

  return reply.code(202).send({ jobId: job.id, message: 'Crawl queued' });
});

app.get('/sources/:id/crawl-status', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user) {
    return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  }
  const shopId = resolveActiveShopId(request, user);
  if (!shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }
  if (!(await ensureShopAccess({ user, shopId }))) {
    return reply.code(403).send({ error: 'No access to this shop' });
  }

  const source = await prisma.source.findFirst({ where: { id: request.params.id, shopId } });
  if (!source) {
    return reply.code(404).send({ error: 'Source not found' });
  }

  const meta = readSourceMeta(source.tagsJson);
  const dataRowCount = await prisma.sourceDataRow.count({ where: { sourceId: source.id } });
  const matchedCount = await prisma.sourceDataRow.count({ where: { sourceId: source.id, NOT: { productId: null } } });

  // Calculate next scheduled crawl
  let nextCrawlAt: string | null = null;
  if (meta.feedType === 'live_url' && meta.lastCrawlAt && meta.crawlFrequency) {
    const lastCrawl = new Date(meta.lastCrawlAt).getTime();
    const intervalMs = meta.crawlFrequency === 'daily' ? 86400000
      : meta.crawlFrequency === 'every_3_days' ? 259200000
      : 604800000; // weekly
    nextCrawlAt = new Date(lastCrawl + intervalMs).toISOString();
  }

  return {
    crawlStatus: meta.crawlStatus ?? 'idle',
    crawlStartedAt: meta.crawlStartedAt ?? null,
    crawlError: meta.crawlError ?? null,
    lastCrawlAt: meta.lastCrawlAt ?? null,
    lastCrawlResult: meta.lastCrawlResult ?? null,
    nextCrawlAt,
    storedRows: dataRowCount,
    matchedRows: matchedCount,
  };
});

app.get('/settings', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }
  const user = await getCurrentUser(request);
  const settings = await prisma.shopSetting.findMany({ where: { shopId: user?.shopId ?? '' }, orderBy: { key: 'asc' } });
  return { settings };
});

app.put('/settings', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }
  const parsed = z.array(shopSettingSchema).safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }
  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }
  await prisma.$transaction(
    parsed.data.map((item) =>
      prisma.shopSetting.upsert({
        where: { shopId_key: { shopId: user.shopId as string, key: item.key } },
        create: { shopId: user.shopId as string, key: item.key, valueJson: item.valueJson },
        update: { valueJson: item.valueJson },
      }),
    ),
  );
  return { ok: true };
});

// ── Completeness stats for all collections ───────────────────────────────────
app.get('/collections/completeness-stats', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  const shopId = user?.shopId ?? '';

  // Collection completeness: 2 checks (title, description) → scores: 0%, 50%, 100%
  const [total, missingBoth, missingDesc, missingTitle] = await Promise.all([
    prisma.collection.count({ where: { shopId } }),
    prisma.collection.count({ where: { shopId, OR: [{ title: '' }, { title: null as any }], AND: [{ OR: [{ descriptionHtml: '' }, { descriptionHtml: null }] }] } }),
    prisma.collection.count({ where: { shopId, NOT: { OR: [{ title: '' }, { title: null as any }] }, AND: [{ OR: [{ descriptionHtml: '' }, { descriptionHtml: null }] }] } }),
    prisma.collection.count({ where: { shopId, OR: [{ title: '' }, { title: null as any }], NOT: { AND: [{ OR: [{ descriptionHtml: '' }, { descriptionHtml: null }] }] } } }),
  ]);
  const bothFilled = total - missingBoth - missingDesc - missingTitle;
  const distribution = [missingBoth, 0, missingDesc + missingTitle, 0, bothFilled];
  return reply.send({ distribution, total });
});

app.get('/collections', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }
  const user = await getCurrentUser(request);
  const shopId = user?.shopId ?? '';
  const q = request.query.q as string | undefined;
  const page = Math.max(1, Number(request.query.page ?? 1));
  const pageSize = Math.min(1000, Math.max(1, Number(request.query.pageSize ?? 200)));
  const skip = (page - 1) * pageSize;
  const syncStatus = request.query.syncStatus as string | undefined;
  const missingField = request.query.missingField as string | undefined;

  const where: any = {
    shopId,
    ...(q
      ? {
          OR: [
            { title: { contains: q, mode: 'insensitive' as const } },
            { handle: { contains: q, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  // Missing field filter for collections (only _title, _description)
  if (missingField) {
    const fieldKeys = missingField.split(',').map((k) => k.trim()).filter(Boolean);
    const andConditions: any[] = [];
    for (const key of fieldKeys) {
      if (key === '_title') andConditions.push({ OR: [{ title: '' }, { title: null as any }] });
      else if (key === '_description') andConditions.push({ OR: [{ descriptionHtml: '' }, { descriptionHtml: null }] });
    }
    if (andConditions.length > 0) {
      where.AND = [...(where.AND ?? []), ...andConditions];
    }
  }

  // Completeness range filter for collections
  const colCompletenessRange = request.query.completenessRange as string | undefined;
  if (colCompletenessRange === '0-19') {
    // Both title and description missing → score 0%
    where.AND = [...(where.AND ?? []),
      { OR: [{ title: '' }, { title: null as any }] },
      { OR: [{ descriptionHtml: '' }, { descriptionHtml: null }] },
    ];
  } else if (colCompletenessRange === '40-59') {
    // Exactly one of title/description missing → score 50%
    where.AND = [...(where.AND ?? []), {
      OR: [
        { AND: [{ NOT: { OR: [{ title: '' }, { title: null as any }] } }, { OR: [{ descriptionHtml: '' }, { descriptionHtml: null }] }] },
        { AND: [{ OR: [{ title: '' }, { title: null as any }] }, { NOT: { OR: [{ descriptionHtml: '' }, { descriptionHtml: null }] } }] },
      ],
    }];
  } else if (colCompletenessRange === '80-100') {
    // Both filled → score 100%
    where.AND = [...(where.AND ?? []),
      { NOT: { OR: [{ title: '' }, { title: null as any }] } },
      { NOT: { OR: [{ descriptionHtml: '' }, { descriptionHtml: null }] } },
    ];
  }

  const [collections, total] = await Promise.all([
    prisma.collection.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip,
      take: pageSize,
    }),
    prisma.collection.count({ where }),
  ]);

  // Compute sync status per collection
  const draftIds = new Set(
    (await prisma.draft.findMany({
      where: { shopId, entityType: 'collection', entityId: { in: collections.map((c) => c.id) }, userId: user?.id },
      select: { entityId: true },
    })).map((d) => d.entityId),
  );

  const enriched = collections.map((c) => {
    const hasDraft = draftIds.has(c.id);
    let status = 'nuværende';
    const lastSync = c.lastShopifySyncAt ? new Date(c.lastShopifySyncAt).getTime() : 0;
    const localUpdated = new Date(c.updatedAt).getTime();
    const shopifyUpdated = c.shopifyUpdatedAt ? new Date(c.shopifyUpdatedAt).getTime() : 0;

    const localAhead = lastSync === 0 || localUpdated > lastSync + 1000;
    const shopifyAhead = shopifyUpdated > 0 && shopifyUpdated > lastSync + 1000;

    if (localAhead && shopifyAhead) status = 'konflikt';
    else if (shopifyAhead) status = 'forældet';
    else if (localAhead) status = 'afventer_sync';
    if (hasDraft) status = 'kladde';

    return { ...c, syncStatus: status, hasDraft };
  });

  let filtered = enriched;
  if (syncStatus) {
    const allowedStatuses = syncStatus.split(',').map((s) => s.trim());
    filtered = enriched.filter((c) => allowedStatuses.includes(c.syncStatus));
  }

  const adjustedTotal = syncStatus ? filtered.length : total;
  return { collections: filtered, total: adjustedTotal, page, pageSize };
});

app.get('/collections/:id', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  await ensureBuiltInFields(user.shopId);

  const [collection, fields, fieldValues, shop] = await Promise.all([
    prisma.collection.findUnique({ where: { id: request.params.id } }),
    prisma.fieldDefinition.findMany({
      where: { shopId: user.shopId, scope: 'collection' },
      orderBy: [{ isBuiltIn: 'desc' }, { createdAt: 'asc' }],
    }),
    prisma.fieldValue.findMany({
      where: { ownerType: 'collection', ownerId: request.params.id },
      include: { fieldDefinition: true },
    }),
    prisma.shop.findUnique({ where: { id: user.shopId }, select: { shopUrl: true } }),
  ]);
  if (!collection) {
    return reply.code(404).send({ error: 'Collection not found' });
  }
  if (collection.shopId !== user.shopId) {
    return reply.code(403).send({ error: 'Forbidden collection access' });
  }

  return { collection: { ...collection, fieldValues, shop }, fields };
});

app.get('/collections/:id/history', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  const collection = await prisma.collection.findFirst({
    where: { id: request.params.id, shopId: user.shopId },
    select: { id: true },
  });
  if (!collection) {
    return reply.code(404).send({ error: 'Collection not found' });
  }

  const [logs, snapshots] = await Promise.all([
    prisma.changeLog.findMany({
      where: { shopId: user.shopId, entityId: collection.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { user: { select: { email: true, firstName: true, lastName: true } } },
    }),
    prisma.snapshot.findMany({
      where: { shopId: user.shopId, entityId: collection.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
  ]);

  return { logs, snapshots };
});

app.patch('/collections/:id', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const parsed = collectionPatchSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }

  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  const existing = await prisma.collection.findFirst({ where: { id: request.params.id, shopId: user.shopId } });
  if (!existing) {
    return reply.code(404).send({ error: 'Collection not found' });
  }

  const updated = await prisma.collection.update({
    where: { id: existing.id },
    data: {
      title: parsed.data.title,
      handle: parsed.data.handle,
      descriptionHtml: parsed.data.descriptionHtml,
    },
  });

  // Upsert custom field values
  if (parsed.data.fieldValues) {
    for (const [fieldDefinitionId, value] of Object.entries(parsed.data.fieldValues)) {
      await prisma.fieldValue.upsert({
        where: { ownerType_ownerId_fieldDefinitionId: { ownerType: 'collection', ownerId: existing.id, fieldDefinitionId } },
        update: { valueJson: value, source: 'user', updatedByUserId: request.user.id },
        create: { ownerType: 'collection', ownerId: existing.id, fieldDefinitionId, valueJson: value, source: 'user', updatedByUserId: request.user.id },
      });
    }
  }

  await createSnapshotAndLog({
    shopId: updated.shopId,
    entityType: 'collection',
    entityId: updated.id,
    reason: 'collection_patch',
    beforeJson: existing,
    afterJson: updated,
    source: 'user',
    userId: request.user.id,
  });

  const shouldSyncNow = parsed.data.syncNow === true;
  let syncJobId: string | null = null;

  if (shouldSyncNow) {
    const syncJob = await prisma.syncJob.create({
      data: {
        shopId: updated.shopId,
        type: 'outbound_collection_patch',
        payloadJson: { collectionId: updated.id, patch: parsed.data },
      },
    });
    await syncQueue.add('outbound-collection', { syncJobId: syncJob.id }, { jobId: syncJob.id });
    syncJobId = syncJob.id;
  }

  return { collection: updated, pendingSync: shouldSyncNow, syncJobId };
});

app.post('/shops/sync-collections', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }
  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }
  const shop = await prisma.shop.findUnique({ where: { id: user.shopId } });
  if (!shop) {
    return reply.code(404).send({ error: 'Shop not found' });
  }

  const existing = await prisma.syncJob.findFirst({
    where: {
      shopId: shop.id,
      type: 'shopify_pull_collections',
      status: { in: ['queued', 'running'] },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) {
    return reply.code(202).send({ jobId: existing.id, deduped: true });
  }

  const syncJob = await prisma.syncJob.create({
    data: {
      shopId: shop.id,
      type: 'shopify_pull_collections',
      status: 'queued',
      payloadJson: { phase: 'queued' },
    },
  });

  const token = decryptSecret(shop.encryptedAdminToken, env.MASTER_ENCRYPTION_KEY);
  const client = new ShopifyGraphQLClient({ storeUrl: shop.shopUrl, adminToken: token });

  const run = async (): Promise<void> => {
    await prisma.syncJob.update({ where: { id: syncJob.id }, data: { status: 'running', runAt: new Date() } });
    try {
      let imported = 0;

      let hasNextPage = true;
      let after: string | null = null;

      while (hasNextPage) {
        const syncResponse: {
          collections: {
            edges: Array<{
              cursor: string;
              node: { id: string; title: string; handle: string; descriptionHtml?: string | null };
            }>;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        } = await client.execute<{
          collections: {
            edges: Array<{
              cursor: string;
              node: { id: string; title: string; handle: string; descriptionHtml?: string | null };
            }>;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        }>(
          `query PullCollections($after: String) {
            collections(first: 250, after: $after) {
              edges {
                cursor
                node {
                  id
                  title
                  handle
                  descriptionHtml
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }`,
          { after },
        );

        for (const edge of syncResponse.collections.edges) {
          const node = edge.node;
          await prisma.collection.upsert({
            where: { shopifyCollectionGid: node.id },
            create: {
              shopId: shop.id,
              shopifyCollectionGid: node.id,
              title: node.title,
              handle: node.handle,
              descriptionHtml: node.descriptionHtml ?? null,
              lastShopifySyncAt: new Date(),
            },
            update: {
              title: node.title,
              handle: node.handle,
              descriptionHtml: node.descriptionHtml ?? null,
              lastShopifySyncAt: new Date(),
            },
          });

          imported += 1;

          if (imported % 50 === 0) {
            await prisma.syncJob.update({
              where: { id: syncJob.id },
              data: {
                payloadJson: { phase: 'running', collectionsImported: imported },
              },
            });
          }
        }

        hasNextPage = syncResponse.collections.pageInfo.hasNextPage;
        after = syncResponse.collections.pageInfo.endCursor;
      }

      await prisma.syncJob.update({
        where: { id: syncJob.id },
        data: {
          status: 'done',
          finishedAt: new Date(),
          payloadJson: { phase: 'done', collectionsImported: imported },
        },
      });
    } catch (error) {
      await prisma.syncJob.update({
        where: { id: syncJob.id },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  };

  void run();
  return reply.code(202).send({ jobId: syncJob.id });
});

app.get('/shops/locales', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user?.shopId) return reply.code(400).send({ error: 'No shop connected' });
  const shop = await prisma.shop.findUnique({ where: { id: user.shopId } });
  if (!shop) return reply.code(404).send({ error: 'Shop not found' });
  try {
    const token = decryptSecret(shop.encryptedAdminToken, env.MASTER_ENCRYPTION_KEY);
    const client = new ShopifyGraphQLClient({ storeUrl: shop.shopUrl, adminToken: token });
    const result = await client.execute<{
      shopLocales: Array<{ locale: string; name: string; primary: boolean; published: boolean }>;
    }>(`query { shopLocales { locale name primary published } }`);
    return reply.send({ locales: result.shopLocales ?? [] });
  } catch {
    return reply.send({ locales: [] });
  }
});

app.get('/mappings', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  const mappings = await prisma.mapping.findMany({
    where: { fieldDefinition: { shopId: user?.shopId ?? '' } },
    include: { fieldDefinition: true },
  });
  return { mappings };
});

app.post('/mappings', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }
  const parsed = mappingSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }

  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  const field = await prisma.fieldDefinition.findFirst({
    where: { id: parsed.data.fieldDefinitionId, shopId: user.shopId },
    select: { id: true },
  });
  if (!field) {
    return reply.code(404).send({ error: 'Field not found for current shop' });
  }

  // Check for existing mapping on the same field before attempting create
  const existing = await prisma.mapping.findUnique({
    where: { fieldDefinitionId: parsed.data.fieldDefinitionId },
    include: { fieldDefinition: true },
  });
  if (existing) {
    return reply.code(409).send({
      error: 'duplicate_mapping',
      message: `Feltet "${existing.fieldDefinition.label}" har allerede en mapping (${existing.direction}). Slet den eksisterende mapping først, eller brug PATCH til at opdatere den.`,
      existingMappingId: existing.id,
    });
  }

  const mapping = await prisma.mapping.create({ data: parsed.data });
  return reply.code(201).send({ mapping });
});

app.patch('/mappings/:id', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) {
    return;
  }
  const parsed = mappingSchema.partial().safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }

  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  const existingMapping = await prisma.mapping.findFirst({
    where: { id: request.params.id, fieldDefinition: { shopId: user.shopId } },
    select: { id: true },
  });
  if (!existingMapping) {
    return reply.code(404).send({ error: 'Mapping not found' });
  }

  if (parsed.data.fieldDefinitionId) {
    const nextField = await prisma.fieldDefinition.findFirst({
      where: { id: parsed.data.fieldDefinitionId, shopId: user.shopId },
      select: { id: true },
    });
    if (!nextField) {
      return reply.code(404).send({ error: 'Field not found for current shop' });
    }
  }

  const mapping = await prisma.mapping.update({ where: { id: existingMapping.id }, data: parsed.data });
  return { mapping };
});

app.delete('/mappings/:id', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  const deleted = await prisma.mapping.deleteMany({ where: { id: request.params.id, fieldDefinition: { shopId: user.shopId } } });
  if (deleted.count === 0) {
    return reply.code(404).send({ error: 'Mapping not found' });
  }

  return { ok: true };
});

// ── Completeness stats for all products ──────────────────────────────────────
app.get('/products/completeness-stats', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  const shopId = resolveActiveShopId(request, user ?? {}) ?? '';

  const fieldDefs = await prisma.fieldDefinition.findMany({
    where: { shopId, scope: 'product' },
    select: { id: true },
  });
  const fieldDefIds = fieldDefs.map((f) => f.id);

  const distribution = [0, 0, 0, 0, 0];
  let total = 0;
  let cursor: string | undefined;

  while (true) {
    const batch = await prisma.product.findMany({
      where: { shopId, shopifyDeletedAt: null },
      select: {
        id: true,
        title: true,
        descriptionHtml: true,
        vendor: true,
        productType: true,
        imagesJson: true,
        variants: { select: { barcode: true }, take: 1, orderBy: { createdAt: 'asc' } },
        fieldValues: { select: { fieldDefinitionId: true, valueJson: true }, where: fieldDefIds.length > 0 ? { fieldDefinitionId: { in: fieldDefIds } } : { fieldDefinitionId: '' } },
      },
      take: 2000,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
    });

    if (batch.length === 0) break;

    for (const p of batch) {
      const images = Array.isArray(p.imagesJson) ? p.imagesJson as unknown[] : [];
      const checks = [
        Boolean(p.title?.trim()),
        Boolean((p.descriptionHtml ?? '').replace(/<[^>]+>/g, '').trim()),
        images.length > 0,
        Boolean(p.vendor?.trim()),
        Boolean(p.productType?.trim()),
        Boolean(p.variants[0]?.barcode?.trim()),
      ];
      for (const fdId of fieldDefIds) {
        const fv = p.fieldValues.find((v) => v.fieldDefinitionId === fdId);
        checks.push(Boolean(fv && String(fv.valueJson ?? '').trim()));
      }
      const score = checks.length > 0 ? Math.round((checks.filter(Boolean).length / checks.length) * 100) : 0;
      if (score < 20) distribution[0]++;
      else if (score < 40) distribution[1]++;
      else if (score < 60) distribution[2]++;
      else if (score < 80) distribution[3]++;
      else distribution[4]++;
      total++;
    }

    cursor = batch[batch.length - 1].id;
    if (batch.length < 2000) break;
  }

  return reply.send({ distribution, total });
});

app.get('/products', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) {
    return;
  }
  const user = await getCurrentUser(request);
  const shopId = (await resolveShopIdForPlatformAdmin(request, user)) ?? '';
  const q = request.query.q as string | undefined;
  const pageRaw = Number(request.query.page ?? 1);
  const pageSizeRaw = Number(request.query.pageSize ?? 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const isBulk = request.query.bulk === '1';
  const pageSize = Number.isFinite(pageSizeRaw)
    ? isBulk ? Math.min(1000, Math.max(1, Math.floor(pageSizeRaw))) : Math.min(100, Math.max(10, Math.floor(pageSizeRaw)))
    : 10;

  // Filter params
  const syncStatus = request.query.syncStatus as string | undefined; // nuværende|kladde|afventer_sync|forældet|konflikt
  const missingField = request.query.missingField as string | undefined; // comma-separated field keys
  const hasField = request.query.hasField as string | undefined;
  const productStatus = request.query.status as string | undefined; // active|draft|archived
  const collectionIdsParam = (request.query.collectionIds as string | undefined) ?? (request.query.collectionId as string | undefined);
  const collectionIds = (collectionIdsParam ?? '').split(',').map((id) => id.trim()).filter(Boolean);

  // Sorting
  const SORTABLE_DIRECT = ['title', 'handle', 'vendor', 'productType', 'status', 'updatedAt', 'lastShopifySyncAt'] as const;
  const rawSortBy = request.query.sortBy as string | undefined;
  const rawSortDir = request.query.sortDir as string | undefined;
  const sortDir: 'asc' | 'desc' = rawSortDir === 'asc' ? 'asc' : 'desc';
  const sortBy = SORTABLE_DIRECT.includes(rawSortBy as any) || rawSortBy === 'totalInventory'
    ? rawSortBy
    : null;

  const buildOrderBy = (): any[] => {
    if (!sortBy) return [{ shopifyProductGid: 'desc' }, { updatedAt: 'desc' }];
    if (sortBy === 'totalInventory') return [{ variants: { _sum: { inventoryQuantity: sortDir } } }, { updatedAt: 'desc' }];
    return [{ [sortBy]: sortDir }, { updatedAt: 'desc' }];
  };
  const canUseProductCollections = await hasProductCollectionTable();

  const where: any = {
    shopId,
    shopifyDeletedAt: null,
    ...(q
      ? {
          OR: [
            { title: { contains: q, mode: 'insensitive' as const } },
            { handle: { contains: q, mode: 'insensitive' as const } },
            { vendor: { contains: q, mode: 'insensitive' as const } },
            {
              variants: {
                some: {
                  OR: [
                    { sku: { contains: q, mode: 'insensitive' as const } },
                    { barcode: { contains: q, mode: 'insensitive' as const } },
                  ],
                },
              },
            },
          ],
        }
      : {}),
  };

  // Shopify product status filter
  if (productStatus) {
    where.status = productStatus;
  }

  let collectionIndexEmpty = false;
  if (collectionIds.length > 0 && canUseProductCollections) {
    // Check if collection memberships have ever been indexed for this shop
    const membershipCount = await prisma.productCollection.count({ where: { shopId } });
    if (membershipCount === 0) {
      collectionIndexEmpty = true;
      // Don't apply filter — table is empty (no sync has run yet)
    } else {
      where.collections = {
        some: {
          collectionId: { in: collectionIds },
          shopId,
        },
      };
    }
  }

  // Missing field filter: find products that DON'T have a value for given field keys
  if (missingField) {
    const fieldKeys = missingField.split(',').map((k) => k.trim()).filter(Boolean);
    const andConditions: any[] = [];
    for (const key of fieldKeys) {
      if (key === '_title') {
        andConditions.push({ OR: [{ title: '' }, { title: null as any }] });
      } else if (key === '_description') {
        andConditions.push({ OR: [{ descriptionHtml: '' }, { descriptionHtml: null }] });
      } else {
        // Custom field: find the FieldDefinition id then check for missing FieldValue
        const fd = await prisma.fieldDefinition.findFirst({ where: { shopId, key } });
        if (fd) {
          andConditions.push({
            NOT: { fieldValues: { some: { fieldDefinitionId: fd.id, NOT: { valueJson: { equals: null as any } } } } },
          });
        }
      }
    }
    if (andConditions.length > 0) {
      where.AND = [...(where.AND ?? []), ...andConditions];
    }
  }

  // Has field filter: find products that DO have a value for given field keys
  if (hasField) {
    const fieldKeys = hasField.split(',').map((k) => k.trim()).filter(Boolean);
    const andConditions: any[] = [];
    for (const key of fieldKeys) {
      if (key === '_title') {
        andConditions.push({ NOT: { OR: [{ title: '' }, { title: null as any }] } });
      } else if (key === '_description') {
        andConditions.push({ NOT: { OR: [{ descriptionHtml: '' }, { descriptionHtml: null }] } });
      } else {
        const fd = await prisma.fieldDefinition.findFirst({ where: { shopId, key } });
        if (fd) {
          andConditions.push({
            fieldValues: { some: { fieldDefinitionId: fd.id, NOT: { valueJson: { equals: null as any } } } },
          });
        }
      }
    }
    if (andConditions.length > 0) {
      where.AND = [...(where.AND ?? []), ...andConditions];
    }
  }

  // Completeness range filter (based on core fields: title, description, images, vendor, productType, barcode)
  const completenessRangeParam = request.query.completenessRange as string | undefined; // e.g. "0-19","20-39","40-59","60-79","80-100"
  if (completenessRangeParam) {
    const BUCKET_RANGES: Record<string, [number, number]> = {
      '0-19': [0, 19], '20-39': [20, 39], '40-59': [40, 59], '60-79': [60, 79], '80-100': [80, 100],
    };
    const range = BUCKET_RANGES[completenessRangeParam];
    if (range) {
      const [minPct, maxPct] = range;
      const rows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT p.id FROM "Product" p
        WHERE p."shopId" = ${shopId} AND p."shopifyDeletedAt" IS NULL
        AND ROUND(
          CAST(
            CASE WHEN p.title IS NOT NULL AND p.title <> '' THEN 1 ELSE 0 END +
            CASE WHEN p."descriptionHtml" IS NOT NULL AND TRIM(REGEXP_REPLACE(p."descriptionHtml", '<[^>]+>', '', 'g')) <> '' THEN 1 ELSE 0 END +
            CASE WHEN jsonb_array_length(p."imagesJson"::jsonb) > 0 THEN 1 ELSE 0 END +
            CASE WHEN p.vendor IS NOT NULL AND p.vendor <> '' THEN 1 ELSE 0 END +
            CASE WHEN p."productType" IS NOT NULL AND p."productType" <> '' THEN 1 ELSE 0 END +
            COALESCE((SELECT CASE WHEN v.barcode IS NOT NULL AND v.barcode <> '' THEN 1 ELSE 0 END FROM "Variant" v WHERE v."productId" = p.id ORDER BY v.position ASC LIMIT 1), 0)
          AS numeric) * 100 / 6
        ) BETWEEN ${minPct} AND ${maxPct}
      `;
      const matchingIds = rows.map((r) => r.id);
      where.id = { in: matchingIds };
    }
  }

  // Sync status pre-filter: resolve computed statuses to product IDs via SQL so
  // pagination and totals are correct (syncStatus is not a stored column).
  // SQL mirrors the JS enrichment logic exactly.
  if (syncStatus) {
    const uid = user?.id ?? '';
    const allowedStatuses = syncStatus.split(',').map((s) => s.trim());
    const idArrays = await Promise.all(allowedStatuses.map(async (status): Promise<string[]> => {
      if (status === 'afventer_sync') {
        const rows = await prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM "Product"
          WHERE "shopId" = ${shopId}
            AND ("lastShopifySyncAt" IS NULL OR EXTRACT(EPOCH FROM ("updatedAt" - "lastShopifySyncAt")) > 1)
            AND NOT ("shopifyUpdatedAt" IS NOT NULL AND ("lastShopifySyncAt" IS NULL OR EXTRACT(EPOCH FROM ("shopifyUpdatedAt" - "lastShopifySyncAt")) > 1))
            AND "id" NOT IN (SELECT "entityId" FROM "Draft" WHERE "shopId" = ${shopId} AND "entityType" = 'product' AND "userId" = ${uid})
        `;
        return rows.map((r) => r.id);
      }
      if (status === 'konflikt') {
        const rows = await prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM "Product"
          WHERE "shopId" = ${shopId}
            AND ("lastShopifySyncAt" IS NULL OR EXTRACT(EPOCH FROM ("updatedAt" - "lastShopifySyncAt")) > 1)
            AND ("shopifyUpdatedAt" IS NOT NULL AND ("lastShopifySyncAt" IS NULL OR EXTRACT(EPOCH FROM ("shopifyUpdatedAt" - "lastShopifySyncAt")) > 1))
            AND "id" NOT IN (SELECT "entityId" FROM "Draft" WHERE "shopId" = ${shopId} AND "entityType" = 'product' AND "userId" = ${uid})
        `;
        return rows.map((r) => r.id);
      }
      if (status === 'forældet') {
        const rows = await prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM "Product"
          WHERE "shopId" = ${shopId}
            AND NOT ("lastShopifySyncAt" IS NULL OR EXTRACT(EPOCH FROM ("updatedAt" - "lastShopifySyncAt")) > 1)
            AND ("shopifyUpdatedAt" IS NOT NULL AND ("lastShopifySyncAt" IS NULL OR EXTRACT(EPOCH FROM ("shopifyUpdatedAt" - "lastShopifySyncAt")) > 1))
            AND "id" NOT IN (SELECT "entityId" FROM "Draft" WHERE "shopId" = ${shopId} AND "entityType" = 'product' AND "userId" = ${uid})
        `;
        return rows.map((r) => r.id);
      }
      if (status === 'nuværende') {
        const rows = await prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM "Product"
          WHERE "shopId" = ${shopId}
            AND NOT ("lastShopifySyncAt" IS NULL OR EXTRACT(EPOCH FROM ("updatedAt" - "lastShopifySyncAt")) > 1)
            AND NOT ("shopifyUpdatedAt" IS NOT NULL AND ("lastShopifySyncAt" IS NULL OR EXTRACT(EPOCH FROM ("shopifyUpdatedAt" - "lastShopifySyncAt")) > 1))
            AND "id" NOT IN (SELECT "entityId" FROM "Draft" WHERE "shopId" = ${shopId} AND "entityType" = 'product' AND "userId" = ${uid})
        `;
        return rows.map((r) => r.id);
      }
      if (status === 'kladde') {
        const rows = await prisma.$queryRaw<{ id: string }[]>`
          SELECT "entityId" as id FROM "Draft"
          WHERE "shopId" = ${shopId} AND "entityType" = 'product' AND "userId" = ${uid}
        `;
        return rows.map((r) => r.id);
      }
      return [];
    }));

    where.id = { in: [...new Set(idArrays.flat())] };
  }

  const [total, pendingSyncRaw, products] = await Promise.all([
    prisma.product.count({ where }),
    prisma.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(*) as count FROM "Product"
      WHERE "shopId" = ${shopId}
        AND ("lastShopifySyncAt" IS NULL OR EXTRACT(EPOCH FROM ("updatedAt" - "lastShopifySyncAt")) > 1)
    `,
    prisma.product.findMany({
      where,
      orderBy: buildOrderBy(),
      include: {
        variants: true,
        ...(canUseProductCollections
          ? {
              collections: {
                include: {
                  collection: {
                    select: { id: true, title: true, handle: true },
                  },
                },
              },
            }
          : {}),
        ...(!isBulk ? { fieldValues: { include: { fieldDefinition: true } } } : {}),
      },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  // Sync status filter — post-filter (calculated field)
  // Also compute syncStatus for each product returned
  const draftIds = new Set(
    (await prisma.draft.findMany({
      where: { shopId, entityType: 'product', entityId: { in: products.map((p) => p.id) }, userId: user?.id },
      select: { entityId: true },
    })).map((d) => d.entityId),
  );

  type ProductWithStatus = typeof products[number] & { syncStatus: string; hasDraft: boolean };
  const enriched: ProductWithStatus[] = products.map((p) => {
    const hasDraft = draftIds.has(p.id);
    let status = 'nuværende';
    const lastSync = p.lastShopifySyncAt ? new Date(p.lastShopifySyncAt).getTime() : 0;
    const localUpdated = new Date(p.updatedAt).getTime();
    const shopifyUpdated = p.shopifyUpdatedAt ? new Date(p.shopifyUpdatedAt).getTime() : 0;

    const localAhead = lastSync === 0 || localUpdated > lastSync + 1000;
    const shopifyAhead = shopifyUpdated > 0 && shopifyUpdated > lastSync + 1000;

    if (localAhead && shopifyAhead) status = 'konflikt';
    else if (shopifyAhead) status = 'forældet';
    else if (localAhead) status = 'afventer_sync';

    if (hasDraft) status = 'kladde';

    return { ...p, syncStatus: status, hasDraft };
  });

  return {
    products: enriched,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    pendingSyncCount: Number(pendingSyncRaw[0]?.count ?? 0),
    collectionFilterAvailable: canUseProductCollections,
    collectionIndexEmpty,
  };
});

app.post('/products', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const createProductSchema = z.object({
    title: z.string().min(1),
    handle: z.string().optional(),
    vendor: z.string().optional(),
    productType: z.string().optional(),
    status: z.enum(['ACTIVE', 'DRAFT', 'ARCHIVED']).optional(),
    tagsJson: z.array(z.string()).optional().default([]),
    descriptionHtml: z.string().optional(),
  });

  const parsed = createProductSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }

  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  const shop = await prisma.shop.findUnique({ where: { id: user.shopId } });
  if (!shop) {
    return reply.code(404).send({ error: 'Shop not found' });
  }

  const token = decryptSecret(shop.encryptedAdminToken, env.MASTER_ENCRYPTION_KEY);
  const client = new ShopifyGraphQLClient({ storeUrl: shop.shopUrl, adminToken: token });

  type ProductCreateResponse = {
    productCreate: {
      product: {
        id: string;
        title: string;
        handle: string;
        vendor?: string | null;
        productType?: string | null;
        status?: string | null;
        descriptionHtml?: string | null;
        tags: string[];
        variants: {
          nodes: Array<{
            id: string;
            sku?: string | null;
            barcode?: string | null;
            price?: string | null;
            compareAtPrice?: string | null;
            selectedOptions?: Array<{ name: string; value: string }>;
          }>;
        };
      } | null;
      userErrors: Array<{ field?: string[]; message: string }>;
    };
  };

  const createResult = await client.execute<ProductCreateResponse>(
    `mutation ProductCreate($input: ProductCreateInput!) {
      productCreate(input: $input) {
        product {
          id
          title
          handle
          vendor
          productType
          status
          descriptionHtml
          tags
          variants(first: 50) {
            nodes {
              id
              sku
              barcode
              price
              compareAtPrice
              selectedOptions { name value }
            }
          }
        }
        userErrors { field message }
      }
    }`,
    {
      input: {
        title: parsed.data.title,
        handle: parsed.data.handle,
        vendor: parsed.data.vendor,
        productType: parsed.data.productType,
        status: parsed.data.status,
        tags: parsed.data.tagsJson,
        descriptionHtml: parsed.data.descriptionHtml,
      },
    },
  );

  const createErrors = createResult.productCreate?.userErrors ?? [];
  if (createErrors.length > 0 || !createResult.productCreate?.product) {
    return reply.code(400).send({ error: createErrors[0]?.message ?? 'Could not create product in Shopify' });
  }

  const sp = createResult.productCreate.product;
  const createdAt = new Date();

  const product = await prisma.product.create({
    data: {
      shopId: shop.id,
      shopifyProductGid: sp.id,
      title: sp.title,
      handle: sp.handle,
      vendor: sp.vendor ?? null,
      productType: sp.productType ?? null,
      status: sp.status ?? 'draft',
      tagsJson: sp.tags ?? [],
      seoJson: {},
      descriptionHtml: sp.descriptionHtml ?? null,
      imagesJson: [],
      createdVia: 'epim',
      lastShopifySyncAt: createdAt,
      shopifyUpdatedAt: createdAt,
    },
  });

  const variants = sp.variants?.nodes ?? [];
  if (variants.length > 0) {
    await prisma.variant.createMany({
      data: variants.map((variant) => ({
        productId: product.id,
        shopifyVariantGid: variant.id,
        sku: variant.sku ?? null,
        barcode: variant.barcode ?? null,
        price: variant.price ?? null,
        compareAtPrice: variant.compareAtPrice ?? null,
        optionValuesJson: (variant.selectedOptions ?? []).map((option) => option.value),
        lastShopifySyncAt: createdAt,
      })),
      skipDuplicates: true,
    });
  }

  await createSnapshotAndLog({
    shopId: shop.id,
    entityType: 'product',
    entityId: product.id,
    reason: 'product_create',
    beforeJson: null,
    afterJson: product,
    source: 'user',
    userId: request.user.id,
  });

  const created = await prisma.product.findUnique({
    where: { id: product.id },
    include: { variants: true },
  });

  return { product: created };
});

app.get('/products/:id', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  const shopId = await resolveShopIdForPlatformAdmin(request, user);
  if (!shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  const product = await prisma.product.findFirst({
    where: { id: request.params.id, shopId },
    include: {
      variants: true,
      fieldValues: {
        include: { fieldDefinition: true },
      },
      shop: { select: { shopUrl: true } },
    },
  });
  if (!product) {
    return reply.code(404).send({ error: 'Not found' });
  }
  return { product };
});

// ── Product translations ──────────────────────────────────────────────────────
app.get('/products/:id/translations', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  const shopId = resolveActiveShopId(request, user ?? {});
  if (!shopId) return reply.code(400).send({ error: 'No active shop.' });

  const product = await prisma.product.findFirst({ where: { id: request.params.id, shopId } });
  if (!product) return reply.code(404).send({ error: 'Not found' });

  const translations = await prisma.productTranslation.findMany({
    where: { productId: product.id },
    orderBy: [{ locale: 'asc' }, { fieldKey: 'asc' }],
  });
  return { translations };
});

app.put('/products/:id/translations', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  const shopId = resolveActiveShopId(request, user ?? {});
  if (!shopId) return reply.code(400).send({ error: 'No active shop.' });

  const product = await prisma.product.findFirst({ where: { id: request.params.id, shopId } });
  if (!product) return reply.code(404).send({ error: 'Not found' });

  const body = request.body as { locale: string; fieldKey: string; value: string };
  if (!body.locale || !body.fieldKey) return reply.code(400).send({ error: 'locale and fieldKey required' });

  const translation = await prisma.productTranslation.upsert({
    where: { productId_locale_fieldKey: { productId: product.id, locale: body.locale, fieldKey: body.fieldKey } },
    create: { productId: product.id, shopId, locale: body.locale, fieldKey: body.fieldKey, value: body.value ?? '' },
    update: { value: body.value ?? '', syncedAt: null, updatedAt: new Date() },
  });
  return { translation };
});

// ── Collection translations ───────────────────────────────────────────────────
app.get('/collections/:id/translations', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  const shopId = resolveActiveShopId(request, user ?? {});
  if (!shopId) return reply.code(400).send({ error: 'No active shop.' });

  const collection = await prisma.collection.findFirst({ where: { id: request.params.id, shopId } });
  if (!collection) return reply.code(404).send({ error: 'Not found' });

  const translations = await prisma.collectionTranslation.findMany({
    where: { collectionId: collection.id },
    orderBy: [{ locale: 'asc' }, { fieldKey: 'asc' }],
  });
  return { translations };
});

app.put('/collections/:id/translations', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  const shopId = resolveActiveShopId(request, user ?? {});
  if (!shopId) return reply.code(400).send({ error: 'No active shop.' });

  const collection = await prisma.collection.findFirst({ where: { id: request.params.id, shopId } });
  if (!collection) return reply.code(404).send({ error: 'Not found' });

  const body = request.body as { locale: string; fieldKey: string; value: string };
  if (!body.locale || !body.fieldKey) return reply.code(400).send({ error: 'locale and fieldKey required' });

  const translation = await prisma.collectionTranslation.upsert({
    where: { collectionId_locale_fieldKey: { collectionId: collection.id, locale: body.locale, fieldKey: body.fieldKey } },
    create: { collectionId: collection.id, shopId, locale: body.locale, fieldKey: body.fieldKey, value: body.value ?? '' },
    update: { value: body.value ?? '', syncedAt: null, updatedAt: new Date() },
  });
  return { translation };
});

app.get('/variants/:id', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  const variant = await prisma.variant.findFirst({
    where: { id: request.params.id, product: { shopId: user.shopId } },
    include: {
      product: { select: { id: true, title: true, handle: true, shopId: true } },
      fieldValues: { include: { fieldDefinition: true } },
    },
  });
  if (!variant) {
    return reply.code(404).send({ error: 'Variant not found' });
  }

  return { variant };
});

app.get('/products/:id/history', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  const product = await prisma.product.findFirst({
    where: { id: request.params.id, shopId: user.shopId },
    select: { id: true },
  });
  if (!product) {
    return reply.code(404).send({ error: 'Product not found' });
  }

  const [logs, snapshots] = await Promise.all([
    prisma.changeLog.findMany({
      where: { shopId: user.shopId, entityId: product.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { user: { select: { email: true, firstName: true, lastName: true } } },
    }),
    prisma.snapshot.findMany({
      where: { shopId: user.shopId, entityId: product.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
  ]);

  return { logs, snapshots };
});

app.patch('/products/:id', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) {
    return;
  }
  const parsed = productPatchSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }

  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  const existing = await prisma.product.findFirst({ where: { id: request.params.id, shopId: user.shopId } });
  if (!existing) {
    return reply.code(404).send({ error: 'Product not found' });
  }

  if (parsed.data.fieldValues?.length) {
    const fieldDefinitionIds = Array.from(new Set(parsed.data.fieldValues.map((item) => item.fieldDefinitionId)));
    const ownedFieldDefinitions = await prisma.fieldDefinition.findMany({
      where: { id: { in: fieldDefinitionIds }, shopId: user.shopId },
      select: { id: true },
    });
    if (ownedFieldDefinitions.length !== fieldDefinitionIds.length) {
      return reply.code(400).send({ error: 'One or more field definitions do not belong to the current shop' });
    }
  }

  const updated = await prisma.product.update({
    where: { id: request.params.id },
    data: {
      title: parsed.data.title,
      handle: parsed.data.handle,
      vendor: parsed.data.vendor,
      productType: parsed.data.productType,
      status: parsed.data.status,
      tagsJson: parsed.data.tagsJson,
      seoJson: parsed.data.seoJson,
      descriptionHtml: parsed.data.descriptionHtml,
      imagesJson: parsed.data.imagesJson,
    },
  });

  if (parsed.data.fieldValues?.length) {
    await Promise.all(
      parsed.data.fieldValues.map((fv) =>
        prisma.fieldValue.upsert({
          where: {
            ownerType_ownerId_fieldDefinitionId: {
              ownerType: 'product',
              ownerId: updated.id,
              fieldDefinitionId: fv.fieldDefinitionId,
            },
          },
          update: {
            valueJson: fv.valueJson,
            source: 'user',
            updatedByUserId: request.user.id,
          },
          create: {
            ownerType: 'product',
            ownerId: updated.id,
            productId: updated.id,
            variantId: null,
            fieldDefinitionId: fv.fieldDefinitionId,
            valueJson: fv.valueJson,
            source: 'user',
            updatedByUserId: request.user.id,
          },
        }),
      ),
    );
  }

  await createSnapshotAndLog({
    shopId: updated.shopId,
    entityType: 'product',
    entityId: updated.id,
    reason: 'product_patch',
    beforeJson: existing,
    afterJson: updated,
    source: 'user',
    userId: request.user.id,
  });

  const shouldSyncNow = parsed.data.syncNow === true;
  let syncJobId: string | null = null;
  const syncRunId = (request.body as any)?.syncRunId as string | undefined;

  if (shouldSyncNow) {
    const syncJob = await prisma.syncJob.create({
      data: {
        shopId: updated.shopId,
        type: 'outbound_product_patch',
        payloadJson: { productId: updated.id, patch: parsed.data, syncRunId: syncRunId ?? null },
      },
    });
    await syncQueue.add('outbound-product', { syncJobId: syncJob.id }, { jobId: syncJob.id });
    syncJobId = syncJob.id;
  }

  return { product: updated, pendingSync: shouldSyncNow, syncJobId };
});

// Bulk delete products (EL-PIM-only, does not push to Shopify)
app.post('/products/bulk-delete', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const { ids } = (request.body ?? {}) as { ids?: string[] };
  if (!Array.isArray(ids) || ids.length === 0) return reply.code(400).send({ error: 'ids array required' });

  const user = await getCurrentUser(request);
  if (!user?.shopId) return reply.code(400).send({ error: 'Connect a shop first' });

  const { count } = await prisma.product.deleteMany({ where: { id: { in: ids }, shopId: user.shopId } });
  return { deleted: count };
});

// Bulk update publication status
app.post('/products/bulk-status', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const { ids, status } = (request.body ?? {}) as { ids?: string[]; status?: string };
  if (!Array.isArray(ids) || ids.length === 0) return reply.code(400).send({ error: 'ids array required' });
  if (!status || !['ACTIVE', 'DRAFT', 'ARCHIVED'].includes(status)) return reply.code(400).send({ error: 'status must be ACTIVE, DRAFT, or ARCHIVED' });

  const user = await getCurrentUser(request);
  if (!user?.shopId) return reply.code(400).send({ error: 'Connect a shop first' });

  const { count } = await prisma.product.updateMany({ where: { id: { in: ids }, shopId: user.shopId }, data: { status } });
  return { updated: count };
});

// Force-pull the latest product data from Shopify for a single product (manual override).
app.post('/products/:id/pull-shopify', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  const shop = await prisma.shop.findUnique({ where: { id: user.shopId } });
  if (!shop) {
    return reply.code(404).send({ error: 'Shop not found' });
  }

  const product = await prisma.product.findFirst({ where: { id: request.params.id, shopId: shop.id } });
  if (!product) {
    return reply.code(404).send({ error: 'Product not found' });
  }

  if (!product.shopifyProductGid) {
    return reply.code(400).send({ error: 'Product has no Shopify GID — it has never been synced from Shopify.' });
  }

  const token = decryptSecret(shop.encryptedAdminToken, env.MASTER_ENCRYPTION_KEY);
  const client = new ShopifyGraphQLClient({ storeUrl: shop.shopUrl, adminToken: token });

  type ShopifyProductResponse = {
    product: {
      id: string;
      title: string;
      handle: string;
      vendor: string;
      productType: string;
      status: string;
      descriptionHtml: string;
      tags: string[];
      seo?: { title?: string | null; description?: string | null } | null;
      featuredImage?: { url: string; altText?: string } | null;
      images?: { edges: Array<{ node: { url: string; altText?: string } }> };
    } | null;
  };

  const result = await client.execute<ShopifyProductResponse>(
    `query GetProduct($id: ID!) {
      product(id: $id) {
        id title handle vendor productType status descriptionHtml tags
        seo { title description }
        featuredImage { url altText }
        images(first: 20) { edges { node { url altText } } }
      }
    }`,
    { id: product.shopifyProductGid },
  );

  if (!result.product) {
    return reply.code(404).send({ error: 'Product not found in Shopify' });
  }

  const sp = result.product;
  const now = new Date();

  // Check for conflict: EL-PIM has local changes not yet pushed
  const hasLocalChanges =
    product.lastShopifySyncAt != null &&
    product.updatedAt.getTime() > product.lastShopifySyncAt.getTime() + 1000;

  if (hasLocalChanges) {
    // Return the Shopify data without applying, let the client decide
    return reply.code(409).send({
      error: 'conflict',
      message: 'EL-PIM har lokale ændringer der ikke er skubbet til Shopify. Accepter Shopify-data og overskriv, eller behold EL-PIM-data.',
      shopifyData: {
        title: sp.title,
        handle: sp.handle,
        vendor: sp.vendor,
        productType: sp.productType,
        status: sp.status,
        descriptionHtml: sp.descriptionHtml,
        tagsJson: sp.tags,
      },
    });
  }

  const updated = await prisma.product.update({
    where: { id: product.id },
    data: {
      title: sp.title,
      handle: sp.handle,
      vendor: sp.vendor || undefined,
      productType: sp.productType || undefined,
      status: sp.status || undefined,
      descriptionHtml: sp.descriptionHtml || undefined,
      tagsJson: sp.tags,
      seoJson: { title: sp.seo?.title ?? null, description: sp.seo?.description ?? null },
      imagesJson: (sp.images?.edges ?? []).map((e) => ({ url: e.node.url, altText: e.node.altText })),
      shopifyUpdatedAt: now,
      lastShopifySyncAt: now,
    },
  });

  await createSnapshotAndLog({
    shopId: shop.id,
    entityType: 'product',
    entityId: product.id,
    reason: 'product_patch',
    beforeJson: product,
    afterJson: updated,
    source: 'shopify',
    userId: request.user.id,
  });

  return { product: updated, applied: true };
});

// Force-apply Shopify data even when there's a local conflict (user chose "accept Shopify").
app.post('/products/:id/accept-shopify', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  const product = await prisma.product.findFirst({ where: { id: request.params.id, shopId: user.shopId } });
  if (!product?.shopifyProductGid) {
    return reply.code(404).send({ error: 'Product not found or has no Shopify GID' });
  }

  const shop = await prisma.shop.findUnique({ where: { id: user.shopId } });
  if (!shop) return reply.code(404).send({ error: 'Shop not found' });

  const token = decryptSecret(shop.encryptedAdminToken, env.MASTER_ENCRYPTION_KEY);
  const client = new ShopifyGraphQLClient({ storeUrl: shop.shopUrl, adminToken: token });

  type ShopifyProductResponse2 = {
    product: { id: string; title: string; handle: string; vendor: string; productType: string; status: string; descriptionHtml: string; tags: string[]; seo?: { title?: string | null; description?: string | null } | null; images?: { edges: Array<{ node: { url: string; altText?: string } }> } } | null;
  };

  const result = await client.execute<ShopifyProductResponse2>(
    `query GetProduct($id: ID!) { product(id: $id) { id title handle vendor productType status descriptionHtml tags seo { title description } images(first: 20) { edges { node { url altText } } } } }`,
    { id: product.shopifyProductGid },
  );

  if (!result.product) return reply.code(404).send({ error: 'Product not found in Shopify' });

  const sp = result.product;
  const now = new Date();
  const updated = await prisma.product.update({
    where: { id: product.id },
    data: { title: sp.title, handle: sp.handle, vendor: sp.vendor || undefined, productType: sp.productType || undefined, status: sp.status || undefined, descriptionHtml: sp.descriptionHtml || undefined, tagsJson: sp.tags, seoJson: { title: sp.seo?.title ?? null, description: sp.seo?.description ?? null }, imagesJson: (sp.images?.edges ?? []).map((e) => ({ url: e.node.url, altText: e.node.altText })), shopifyUpdatedAt: now, lastShopifySyncAt: now },
  });

  await createSnapshotAndLog({ shopId: shop.id, entityType: 'product', entityId: product.id, reason: 'product_patch', beforeJson: product, afterJson: updated, source: 'shopify', userId: request.user.id });

  return { product: updated };
});

// GET /products/:id/publications — list Shopify publication channels for product
app.get('/products/:id/publications', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user?.shopId) return reply.code(400).send({ error: 'Connect a shop first' });
  const shop = await prisma.shop.findUnique({ where: { id: user.shopId } });
  if (!shop) return reply.code(404).send({ error: 'Shop not found' });
  const product = await prisma.product.findFirst({ where: { id: request.params.id, shopId: shop.id } });
  if (!product) return reply.code(404).send({ error: 'Product not found' });
  if (!product.shopifyProductGid) return reply.code(400).send({ error: 'Product not synced with Shopify' });
  try {
    const token = decryptSecret(shop.encryptedAdminToken, env.MASTER_ENCRYPTION_KEY);
    const client = new ShopifyGraphQLClient({ storeUrl: shop.shopUrl, adminToken: token });

    // Fetch all shop channels AND the product's current publication state in one call
    const data = await client.execute<{
      publications: { nodes: Array<{ id: string; name: string }> };
      product: {
        resourcePublications: {
          nodes: Array<{ isPublished: boolean; publication: { id: string } }>;
        };
      };
    }>(`query GetPublications($productId: ID!) {
      publications(first: 20) {
        nodes { id name }
      }
      product(id: $productId) {
        resourcePublications(first: 20) {
          nodes {
            isPublished
            publication { id }
          }
        }
      }
    }`, { productId: product.shopifyProductGid });

    // Build a map: publicationId → isPublished from the product's current state
    const publishedMap = new Map<string, boolean>(
      data.product.resourcePublications.nodes.map((n) => [n.publication.id, n.isPublished]),
    );

    // Return ALL shop channels with the product's publish state (default false)
    const publications = data.publications.nodes.map((ch) => ({
      id: ch.id,
      name: ch.name,
      isPublished: publishedMap.get(ch.id) ?? false,
    }));

    return { publications };
  } catch (err) {
    request.log.error({ err }, 'failed to fetch publications from Shopify');
    return reply.code(502).send({ error: 'Could not fetch publications from Shopify' });
  }
});

// PUT /products/:id/publications — publish or unpublish from a channel
app.put('/products/:id/publications', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user?.shopId) return reply.code(400).send({ error: 'Connect a shop first' });
  const shop = await prisma.shop.findUnique({ where: { id: user.shopId } });
  if (!shop) return reply.code(404).send({ error: 'Shop not found' });
  const product = await prisma.product.findFirst({ where: { id: request.params.id, shopId: shop.id } });
  if (!product) return reply.code(404).send({ error: 'Product not found' });
  if (!product.shopifyProductGid) return reply.code(400).send({ error: 'Product not synced with Shopify' });
  const { publicationId, publish } = request.body as { publicationId: string; publish: boolean };
  if (!publicationId || typeof publish !== 'boolean') return reply.code(400).send({ error: 'publicationId and publish required' });
  try {
    const token = decryptSecret(shop.encryptedAdminToken, env.MASTER_ENCRYPTION_KEY);
    const client = new ShopifyGraphQLClient({ storeUrl: shop.shopUrl, adminToken: token });
    if (publish) {
      await client.execute(`mutation PublishProduct($id: ID!, $input: [PublicationInput!]!) {
        publishablePublish(id: $id, input: $input) {
          userErrors { field message }
        }
      }`, { id: product.shopifyProductGid, input: [{ publicationId }] });
    } else {
      await client.execute(`mutation UnpublishProduct($id: ID!, $input: [PublicationInput!]!) {
        publishableUnpublish(id: $id, input: $input) {
          userErrors { field message }
        }
      }`, { id: product.shopifyProductGid, input: [{ publicationId }] });
    }
    return { ok: true };
  } catch (err) {
    request.log.error({ err }, 'failed to update publication in Shopify');
    return reply.code(502).send({ error: 'Could not update publication in Shopify' });
  }
});

// Recent webhook delivery log for diagnostics.
app.get('/webhooks/recent', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }
  const user = await getCurrentUser(request);
  const jobs = await prisma.syncJob.findMany({
    where: {
      shopId: user?.shopId ?? '',
      type: { startsWith: 'webhook_' },
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, type: true, status: true, createdAt: true, error: true },
  });
  return { jobs };
});

// Queue a single product for outbound Shopify sync without touching its fields.
app.post('/products/:id/sync', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  const product = await prisma.product.findFirst({ where: { id: request.params.id, shopId: user.shopId } });
  if (!product) {
    return reply.code(404).send({ error: 'Product not found' });
  }

  const syncJob = await prisma.syncJob.create({
    data: {
      shopId: product.shopId,
      type: 'outbound_product_patch',
      payloadJson: { productId: product.id, patch: {} } as any,
    },
  });
  await syncQueue.add('outbound-product', { syncJobId: syncJob.id }, { jobId: syncJob.id });

  return { syncJobId: syncJob.id };
});

// Queue all products that have been updated locally since last Shopify sync.
app.post('/products/sync-pending', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  const allProducts = await prisma.product.findMany({
    where: { shopId: user.shopId },
    select: { id: true, shopId: true, updatedAt: true, lastShopifySyncAt: true },
  });

  const pending = allProducts.filter(
    (p) => !p.lastShopifySyncAt || p.updatedAt.getTime() > p.lastShopifySyncAt.getTime() + 1000,
  );

  // Create a SyncRun for this batch
  let syncRunId: string | null = null;
  if (pending.length > 0) {
    const syncRun = await prisma.syncRun.create({
      data: {
        shopId: user.shopId,
        direction: 'outbound',
        productCount: pending.length,
        initiatedBy: user.id,
      },
    });
    syncRunId = syncRun.id;
  }

  const syncJobIds: string[] = [];
  for (const p of pending) {
    const existing = await prisma.syncJob.findFirst({
      where: { shopId: p.shopId, type: 'outbound_product_patch', status: { in: ['queued', 'running'] }, payloadJson: { path: ['productId'], equals: p.id } },
    });
    if (existing) {
      syncJobIds.push(existing.id);
      continue;
    }
    const syncJob = await prisma.syncJob.create({
      data: {
        shopId: p.shopId,
        type: 'outbound_product_patch',
        payloadJson: { productId: p.id, patch: {}, syncRunId } as any,
      },
    });
    await syncQueue.add('outbound-product', { syncJobId: syncJob.id }, { jobId: syncJob.id });
    syncJobIds.push(syncJob.id);
  }

  // Also commit and sync draft (kladde) products
  const draftProducts = await prisma.draft.findMany({
    where: { shopId: user.shopId, entityType: 'product' },
    orderBy: { updatedAt: 'desc' },
    distinct: ['entityId'],
  });

  for (const draft of draftProducts) {
    const patch = draft.patchJson as any;
    const product = await prisma.product.findFirst({ where: { id: draft.entityId, shopId: user.shopId } });
    if (!product) continue;

    // Apply simple product fields from draft
    const updateData: Record<string, unknown> = {};
    for (const field of ['title', 'handle', 'vendor', 'productType', 'descriptionHtml', 'status', 'tagsJson', 'seoJson', 'imagesJson'] as const) {
      if (patch[field] !== undefined) updateData[field] = patch[field];
    }
    if (Object.keys(updateData).length > 0) {
      await prisma.product.update({ where: { id: product.id }, data: updateData });
    }

    // Apply custom field values from draft
    if (Array.isArray(patch.fieldValues) && patch.fieldValues.length > 0) {
      await Promise.all(
        patch.fieldValues.map((fv: { fieldDefinitionId: string; valueJson: unknown }) =>
          prisma.fieldValue.upsert({
            where: { ownerType_ownerId_fieldDefinitionId: { ownerType: 'product', ownerId: product.id, fieldDefinitionId: fv.fieldDefinitionId } },
            update: { valueJson: fv.valueJson as any, source: 'user' },
            create: { ownerType: 'product', ownerId: product.id, productId: product.id, variantId: null, fieldDefinitionId: fv.fieldDefinitionId, valueJson: fv.valueJson as any, source: 'user' },
          }),
        ),
      );
    }

    // Delete the draft
    await prisma.draft.deleteMany({ where: { shopId: user.shopId, entityType: 'product', entityId: draft.entityId } });

    // Queue sync job (skip if already queued)
    const existingJob = await prisma.syncJob.findFirst({
      where: { shopId: user.shopId, type: 'outbound_product_patch', status: { in: ['queued', 'running'] }, payloadJson: { path: ['productId'], equals: draft.entityId } },
    });
    if (!existingJob) {
      const syncJob = await prisma.syncJob.create({
        data: { shopId: user.shopId, type: 'outbound_product_patch', payloadJson: { productId: draft.entityId, patch: {}, syncRunId } as any },
      });
      await syncQueue.add('outbound-product', { syncJobId: syncJob.id }, { jobId: syncJob.id });
      syncJobIds.push(syncJob.id);
    }
  }

  return { queued: syncJobIds.length, total: pending.length + draftProducts.length, syncJobIds, syncRunId };
});

app.patch('/variants/:id', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) {
    return;
  }
  const parsed = variantPatchSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }

  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  const existing = await prisma.variant.findFirst({
    where: { id: request.params.id, product: { shopId: user.shopId } },
    include: { product: true },
  });
  if (!existing) {
    return reply.code(404).send({ error: 'Variant not found' });
  }

  if (parsed.data.fieldValues?.length) {
    const fieldDefinitionIds = Array.from(new Set(parsed.data.fieldValues.map((item) => item.fieldDefinitionId)));
    const ownedFieldDefinitions = await prisma.fieldDefinition.findMany({
      where: {
        id: { in: fieldDefinitionIds },
        shopId: user.shopId,
      },
      select: { id: true },
    });
    if (ownedFieldDefinitions.length !== fieldDefinitionIds.length) {
      return reply.code(400).send({ error: 'One or more field definitions do not belong to the current shop' });
    }
  }

  const updated = await prisma.variant.update({
    where: { id: request.params.id },
    data: {
      sku: parsed.data.sku,
      barcode: parsed.data.barcode,
      price: parsed.data.price,
      compareAtPrice: parsed.data.compareAtPrice,
      optionValuesJson: parsed.data.optionValuesJson,
      weight: parsed.data.weight,
      weightUnit: parsed.data.weightUnit,
      requiresShipping: parsed.data.requiresShipping,
      taxable: parsed.data.taxable,
      inventoryPolicy: parsed.data.inventoryPolicy,
      ...(parsed.data.hsCode !== undefined ? { hsCode: parsed.data.hsCode } : {}),
      ...(parsed.data.countryOfOrigin !== undefined ? { countryOfOrigin: parsed.data.countryOfOrigin } : {}),
    },
  });

  if (parsed.data.fieldValues?.length) {
    await Promise.all(
      parsed.data.fieldValues.map((fv) =>
        prisma.fieldValue.upsert({
          where: {
            ownerType_ownerId_fieldDefinitionId: {
              ownerType: 'variant',
              ownerId: updated.id,
              fieldDefinitionId: fv.fieldDefinitionId,
            },
          },
          update: {
            valueJson: fv.valueJson,
            source: 'user',
            updatedByUserId: request.user.id,
          },
          create: {
            ownerType: 'variant',
            ownerId: updated.id,
            productId: existing.productId,
            variantId: updated.id,
            fieldDefinitionId: fv.fieldDefinitionId,
            valueJson: fv.valueJson,
            source: 'user',
            updatedByUserId: request.user.id,
          },
        }),
      ),
    );
  }

  await createSnapshotAndLog({
    shopId: existing.product.shopId,
    entityType: 'variant',
    entityId: updated.id,
    reason: 'variant_patch',
    beforeJson: existing,
    afterJson: updated,
    source: 'user',
    userId: request.user.id,
  });

  const shouldSyncNow = parsed.data.syncNow === true;
  let syncJobId: string | null = null;

  if (shouldSyncNow) {
    const syncJob = await prisma.syncJob.create({
      data: {
        shopId: existing.product.shopId,
        type: 'outbound_variant_patch',
        payloadJson: { variantId: updated.id, patch: parsed.data },
      },
    });
    await syncQueue.add('outbound-variant', { syncJobId: syncJob.id }, { jobId: syncJob.id });
    syncJobId = syncJob.id;
  }

  return { variant: updated, pendingSync: shouldSyncNow, syncJobId };
});

app.post('/variants/:id/ai-suggest', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user?.shopId) return reply.code(400).send({ error: 'No shop connected' });

  const { field, weightUnit } = (request.body ?? {}) as { field?: string; weightUnit?: string };
  if (!field || !['hsCode', 'countryOfOrigin', 'weight'].includes(field)) {
    return reply.code(400).send({ error: 'Invalid field' });
  }

  const variant = await prisma.variant.findFirst({
    where: { id: request.params.id, product: { shopId: user.shopId } },
    include: { product: true },
  });
  if (!variant) return reply.code(404).send({ error: 'Variant not found' });

  const platformKeyRow = await prisma.platformSetting.findUnique({ where: { key: 'openai_api_key' } });
  const platformKeyData = (platformKeyRow?.valueJson ?? {}) as Record<string, unknown>;
  const encryptedPlatformKey = typeof platformKeyData.encryptedKey === 'string' ? platformKeyData.encryptedKey : null;
  if (!encryptedPlatformKey) return reply.code(503).send({ error: 'Platform OpenAI key not configured' });
  const openAiApiKey = decryptSecret(encryptedPlatformKey, env.MASTER_ENCRYPTION_KEY);

  const p = variant.product;
  let prompt = '';
  if (field === 'hsCode') {
    prompt = `Du er en certificeret toldekspert. Find den eksakte HS-kode (Harmonized System code, 6-10 cifre) for dette produkt. Returner KUN koden som et rent tal uden punktummer, bindestreger eller mellemrum (fx 6110201000). Hvis du IKKE er 100% sikker på den korrekte kode, returner præcis teksten: UNSURE\n\nProdukt: ${p.title ?? ''}\nBeskrivelse: ${(p.descriptionHtml ?? '').replace(/<[^>]+>/g, ' ').slice(0, 300)}\nVaremærke: ${p.vendor ?? ''}\nProdukttype: ${p.productType ?? ''}`;
  } else if (field === 'countryOfOrigin') {
    prompt = `Du er en supply chain specialist. Angiv det præcise produktionsland (ISO 3166-1 alpha-2 landekode, 2 store bogstaver fx "CN", "DE", "DK") for dette produkt. Returner KUN de 2 bogstavers landekode uden forklaring. Hvis du IKKE er 100% sikker på det korrekte produktionsland, returner præcis teksten: UNSURE\n\nProdukt: ${p.title ?? ''}\nVaremærke: ${p.vendor ?? ''}\nProdukttype: ${p.productType ?? ''}`;
  } else {
    const unit = weightUnit ?? variant.weightUnit ?? 'KILOGRAMS';
    const unitLabel = unit === 'KILOGRAMS' ? 'kg' : unit === 'GRAMS' ? 'g' : unit === 'POUNDS' ? 'lbs' : 'oz';
    prompt = `Du er produktspecialist. Søg på internettet og find den PRÆCISE og OFFICIELLE vægt for dette produkt direkte fra producentens specifikationer eller en anden pålidelig kilde. Returner KUN et tal (decimaltal med punktum som separator, fx 2.5) i enheden ${unitLabel} — ingen tekst, ingen enhedsbetegnelse, ingen forklaring. Hvis du IKKE kan finde den præcise vægt fra en verificerbar kilde, returner præcis teksten: UNSURE\n\nProdukt: ${p.title ?? ''}\nVaremærke: ${p.vendor ?? ''}\nProdukttype: ${p.productType ?? ''}\nSKU: ${variant.sku ?? ''}\nBeskrivelse: ${(p.descriptionHtml ?? '').replace(/<[^>]+>/g, ' ').slice(0, 300)}`;
  }

  try {
    const isWeight = field === 'weight';
    const aiResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openAiApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: isWeight ? 'gpt-4o-search-preview' : 'gpt-4o-mini',
        ...(isWeight ? {} : { temperature: 0 }),
        max_tokens: 50,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const aiJson = await aiResp.json() as { choices?: Array<{ message?: { content?: string } }> };
    const raw = aiJson.choices?.[0]?.message?.content?.trim() ?? '';

    if (field === 'hsCode') {
      if (!raw || raw.toUpperCase() === 'UNSURE') {
        return reply.code(422).send({ error: 'AI kunne ikke fastslå en sikker HS-kode for dette produkt' });
      }
      const cleaned = raw.replace(/[^\d]/g, '');
      if (!/^\d{6,10}$/.test(cleaned)) {
        return reply.code(422).send({ error: 'AI returnerede en ugyldig HS-kode' });
      }
      return reply.send({ value: cleaned });
    } else if (field === 'countryOfOrigin') {
      if (!raw || raw.toUpperCase() === 'UNSURE') {
        return reply.code(422).send({ error: 'AI kunne ikke fastslå et sikkert oprindelsesland for dette produkt' });
      }
      const cleaned = raw.replace(/[^A-Za-z]/g, '').toUpperCase();
      if (!/^[A-Z]{2}$/.test(cleaned)) {
        return reply.code(422).send({ error: 'AI returnerede et ugyldigt landekode' });
      }
      return reply.send({ value: cleaned });
    } else {
      // weight
      if (!raw || raw.toUpperCase() === 'UNSURE') {
        return reply.code(422).send({ error: 'AI kunne ikke fastslå en sikker vægt for dette produkt' });
      }
      const cleaned = raw.replace(/[^\d.]/g, '');
      const num = parseFloat(cleaned);
      if (!Number.isFinite(num) || num <= 0) {
        return reply.code(422).send({ error: 'AI returnerede en ugyldig vægt' });
      }
      return reply.send({ value: String(num) });
    }
  } catch (err) {
    return reply.code(500).send({ error: 'AI generation failed' });
  }
});

app.post('/bulk/patch', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) {
    return;
  }
  const parsed = bulkPatchSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }

  const user = await getCurrentUser(request);
  const shopId = user?.shopId ?? '';

  // Create SyncRun if syncing
  let syncRunId: string | null = null;
  if (parsed.data.syncNow && (parsed.data.products.length + parsed.data.variants.length) > 0) {
    const syncRun = await prisma.syncRun.create({
      data: {
        shopId,
        direction: 'outbound',
        productCount: parsed.data.products.length,
        initiatedBy: user?.id,
      },
    });
    syncRunId = syncRun.id;

    // Snapshot product state BEFORE patches are applied (needed for rollback)
    const productIds = parsed.data.products.map((p) => p.id);
    const preSnapProducts = await prisma.product.findMany({
      where: { id: { in: productIds }, shopId },
      select: { id: true, title: true, handle: true, vendor: true, productType: true, descriptionHtml: true, tagsJson: true },
    });
    if (preSnapProducts.length > 0) {
      await prisma.syncRunProductSnapshot.createMany({
        data: preSnapProducts.map((p) => ({
          syncRunId: syncRunId!,
          productId: p.id,
          snapshotJson: {
            title: p.title,
            handle: p.handle,
            vendor: p.vendor,
            productType: p.productType,
            descriptionHtml: p.descriptionHtml,
            tagsJson: p.tagsJson,
          },
        })),
        skipDuplicates: true,
      });
    }
  }

  const syncJobIds: string[] = [];
  const forwardHeaders: Record<string, string> = {
    authorization: request.headers.authorization as string,
    ...(request.headers['x-elpim-shop-id'] ? { 'x-elpim-shop-id': request.headers['x-elpim-shop-id'] as string } : {}),
  };

  for (const productPatch of parsed.data.products) {
    const response = await app.inject({
      method: 'PATCH',
      url: `/products/${productPatch.id}`,
      payload: { ...productPatch.patch, syncNow: parsed.data.syncNow, syncRunId },
      headers: forwardHeaders,
    });

    if (response.statusCode >= 400) {
      return reply.code(response.statusCode).send(response.json());
    }
    const body = response.json() as { syncJobId?: string | null };
    if (body.syncJobId) {
      syncJobIds.push(body.syncJobId);
    }

    // Delete draft for this product if it exists
    if (shopId) {
      await prisma.draft.deleteMany({
        where: { shopId, entityType: 'product', entityId: productPatch.id },
      });
    }
  }

  for (const variantPatch of parsed.data.variants) {
    const response = await app.inject({
      method: 'PATCH',
      url: `/variants/${variantPatch.id}`,
      payload: { ...variantPatch.patch, syncNow: parsed.data.syncNow },
      headers: forwardHeaders,
    });

    if (response.statusCode >= 400) {
      return reply.code(response.statusCode).send(response.json());
    }
    const body = response.json() as { syncJobId?: string | null };
    if (body.syncJobId) {
      syncJobIds.push(body.syncJobId);
    }
  }

  return { ok: true, syncJobIds, syncRunId };
});

// ══════════════════════════════════════════════════════════════════════════════
// SYNC RUNS — History & Rollback
// ══════════════════════════════════════════════════════════════════════════════

app.get('/sync-runs', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid.' });
  const shopId = resolveActiveShopId(request, user);
  if (!shopId) return reply.code(400).send({ error: 'No active shop.' });

  const page = Math.max(1, Number((request.query as any).page ?? 1));
  const pageSize = Math.min(50, Math.max(1, Number((request.query as any).pageSize ?? 20)));

  const [total, runs] = await Promise.all([
    prisma.syncRun.count({ where: { shopId } }),
    prisma.syncRun.findMany({
      where: { shopId },
      include: {
        user: { select: { id: true, email: true, firstName: true, lastName: true } },
        _count: { select: { productSnapshots: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return {
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
    runs: runs.map((r) => ({
      id: r.id,
      direction: r.direction,
      status: r.status,
      productCount: r.productCount,
      createdAt: r.createdAt,
      finishedAt: r.finishedAt,
      rolledBackAt: r.rolledBackAt,
      rolledBackByUserId: r.rolledBackByUserId,
      canRollback: r.direction === 'outbound' && r.status === 'done' && !r.rolledBackAt && r._count.productSnapshots > 0,
      initiatedBy: r.user ? { id: r.user.id, email: r.user.email, name: [r.user.firstName, r.user.lastName].filter(Boolean).join(' ') || null } : null,
    })),
  };
});

app.post('/sync-runs/:id/rollback', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid.' });
  const shopId = resolveActiveShopId(request, user);
  if (!shopId) return reply.code(400).send({ error: 'No active shop.' });

  const syncRun = await prisma.syncRun.findFirst({
    where: { id: request.params.id, shopId },
    include: { _count: { select: { productSnapshots: true } } },
  });
  if (!syncRun) return reply.code(404).send({ error: 'Synkronisering ikke fundet.' });
  if (syncRun.rolledBackAt) return reply.code(400).send({ error: 'Denne synkronisering er allerede rullet tilbage.' });
  if (syncRun.direction !== 'outbound') return reply.code(400).send({ error: 'Kun outbound synkroniseringer kan rulles tilbage.' });
  if (syncRun._count.productSnapshots === 0) return reply.code(400).send({ error: 'Ingen snapshot-data tilgængeligt for denne synkronisering.' });

  const snapshots = await prisma.syncRunProductSnapshot.findMany({ where: { syncRunId: syncRun.id } });

  // Create a rollback SyncRun to track this batch
  const rollbackRun = await prisma.syncRun.create({
    data: { shopId, direction: 'outbound', productCount: snapshots.length, initiatedBy: user.id },
  });

  let restored = 0;
  const errors: string[] = [];

  for (const snapshot of snapshots) {
    try {
      const snap = snapshot.snapshotJson as {
        title?: string | null;
        handle?: string | null;
        vendor?: string | null;
        productType?: string | null;
        descriptionHtml?: string | null;
        tagsJson?: unknown;
      };

      const updateData: Record<string, unknown> = {};
      if (snap.title != null) updateData.title = snap.title;
      if (snap.handle != null) updateData.handle = snap.handle;
      if (snap.vendor != null) updateData.vendor = snap.vendor;
      if (snap.productType != null) updateData.productType = snap.productType;
      if (snap.descriptionHtml != null) updateData.descriptionHtml = snap.descriptionHtml;
      if (snap.tagsJson != null) updateData.tagsJson = snap.tagsJson as any;

      if (Object.keys(updateData).length === 0) continue;

      // Restore product in DB
      const updated = await prisma.product.updateMany({
        where: { id: snapshot.productId, shopId },
        data: updateData,
      });
      if (updated.count === 0) continue; // product may have been deleted

      // Enqueue outbound sync job to push restored values to Shopify
      const syncJob = await prisma.syncJob.create({
        data: {
          shopId,
          type: 'outbound_product_patch',
          payloadJson: { productId: snapshot.productId, patch: updateData, syncRunId: rollbackRun.id } as any,
        },
      });
      await syncQueue.add('outbound-product', { syncJobId: syncJob.id }, { jobId: syncJob.id });
      restored += 1;
    } catch (err: unknown) {
      errors.push(`product ${snapshot.productId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Mark original run as rolled back
  await prisma.syncRun.update({
    where: { id: syncRun.id },
    data: { rolledBackAt: new Date(), rolledBackByUserId: user.id },
  });

  // Update rollback run status
  await prisma.syncRun.update({
    where: { id: rollbackRun.id },
    data: { status: errors.length > 0 ? 'failed' : 'done', finishedAt: new Date(), productCount: restored },
  });

  return { ok: true, restored, errors, rollbackSyncRunId: rollbackRun.id };
});

app.post('/sync-jobs/status', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const body = request.body as { jobIds?: string[] };
  const jobIds = (body.jobIds ?? []).filter((id) => typeof id === 'string' && id.length > 0);
  if (!jobIds.length) {
    return reply.code(400).send({ error: 'jobIds is required' });
  }

  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  const jobs = await prisma.syncJob.findMany({
    where: { id: { in: jobIds }, shopId: user.shopId },
    select: { id: true, status: true, error: true, finishedAt: true, type: true, payloadJson: true },
  });

  const totals = {
    total: jobs.length,
    done: jobs.filter((j) => j.status === 'done').length,
    failed: jobs.filter((j) => j.status === 'failed').length,
    running: jobs.filter((j) => j.status === 'running').length,
    queued: jobs.filter((j) => j.status === 'queued').length,
    held: jobs.filter((j) => j.status === 'held').length,
  };

  return { jobs, totals };
});

// ──────────── Drafts ────────────

app.put('/drafts', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user?.shopId) return reply.code(400).send({ error: 'Connect a shop first' });

  const body = request.body as { entityType: string; entityId: string; patchJson: Record<string, unknown> };
  if (!body?.entityType || !body?.entityId || !body?.patchJson) {
    return reply.code(400).send({ error: 'entityType, entityId, patchJson required' });
  }
  if (!['product', 'collection'].includes(body.entityType)) {
    return reply.code(400).send({ error: 'entityType must be product or collection' });
  }

  const draft = await prisma.draft.upsert({
    where: {
      entityType_entityId_userId: {
        entityType: body.entityType,
        entityId: body.entityId,
        userId: user.id,
      },
    },
    update: { patchJson: body.patchJson as any },
    create: {
      shopId: user.shopId,
      entityType: body.entityType,
      entityId: body.entityId,
      patchJson: body.patchJson as any,
      userId: user.id,
    },
  });

  return { draft };
});

app.get('/drafts', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  const shopId = resolveActiveShopId(request, user);
  if (!shopId) return reply.code(400).send({ error: 'Connect a shop first' });

  const entityType = request.query.entityType as string | undefined;
  const entityId = request.query.entityId as string | undefined;

  const where: any = { shopId, userId: user.id };
  if (entityType) where.entityType = entityType;
  if (entityId) where.entityId = entityId;

  const drafts = await prisma.draft.findMany({ where, orderBy: { updatedAt: 'desc' } });
  return { drafts };
});

app.delete('/drafts/:entityType/:entityId', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  const shopId = resolveActiveShopId(request, user);
  if (!shopId) return reply.code(400).send({ error: 'Connect a shop first' });

  const { entityType, entityId } = request.params;
  await prisma.draft.deleteMany({
    where: { shopId, entityType, entityId, userId: user.id },
  });

  return { ok: true };
});

// Commit a product draft and immediately queue a Shopify sync job
app.post('/drafts/product/:productId/commit', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  const shopId = resolveActiveShopId(request, user);
  if (!shopId) return reply.code(400).send({ error: 'Connect a shop first' });

  const { productId } = request.params;
  const draft = await prisma.draft.findFirst({
    where: { shopId, entityType: 'product', entityId: productId, userId: user.id },
  });
  if (!draft) return reply.code(404).send({ error: 'Draft not found' });

  const product = await prisma.product.findFirst({ where: { id: productId, shopId } });
  if (!product) return reply.code(404).send({ error: 'Product not found' });

  const patch = draft.patchJson as any;

  // Apply simple product fields
  const updateData: Record<string, unknown> = {};
  for (const field of ['title', 'handle', 'vendor', 'productType', 'descriptionHtml', 'status', 'tagsJson', 'seoJson', 'imagesJson'] as const) {
    if (patch[field] !== undefined) updateData[field] = patch[field];
  }
  if (Object.keys(updateData).length > 0) {
    await prisma.product.update({ where: { id: productId }, data: updateData });
  }

  // Apply custom field values
  if (Array.isArray(patch.fieldValues) && patch.fieldValues.length > 0) {
    await Promise.all(
      patch.fieldValues.map((fv: { fieldDefinitionId: string; valueJson: unknown }) =>
        prisma.fieldValue.upsert({
          where: { ownerType_ownerId_fieldDefinitionId: { ownerType: 'product', ownerId: productId, fieldDefinitionId: fv.fieldDefinitionId } },
          update: { valueJson: fv.valueJson as any, source: 'user' },
          create: { ownerType: 'product', ownerId: productId, productId, variantId: null, fieldDefinitionId: fv.fieldDefinitionId, valueJson: fv.valueJson as any, source: 'user' },
        }),
      ),
    );
  }

  // Delete the draft
  await prisma.draft.deleteMany({ where: { shopId, entityType: 'product', entityId: productId, userId: user.id } });

  // Queue sync job
  const syncJob = await prisma.syncJob.create({
    data: { shopId, type: 'outbound_product_patch', payloadJson: { productId, patch: {} } as any },
  });
  await syncQueue.add('outbound-product', { syncJobId: syncJob.id }, { jobId: syncJob.id });

  return { ok: true, syncJobId: syncJob.id };
});

// ──────────── Feeds ────────────

// Helper: resolve a Shopify product field by source key
function resolveFeedSource(source: string, product: any, shopUrl: string): string {
  if (source.startsWith('static:')) return source.slice(7);
  switch (source) {
    case 'title': return product.title ?? '';
    case 'handle': return product.handle ?? '';
    case 'vendor': return product.vendor ?? '';
    case 'product_type': return product.productType ?? '';
    case 'description': return (product.descriptionHtml ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    case 'description_html': return product.descriptionHtml ?? '';
    case 'tags': return (product.tags ?? []).join(',');
    case 'id': return String(product.id ?? '').replace(/[^0-9]/g, '').slice(-13);
    case 'url': return `${shopUrl}/products/${product.handle ?? ''}`;
    case 'availability': return ((product.totalInventory ?? 0) > 0) ? 'in stock' : 'out of stock';
    case 'images.0.url': return product.images?.nodes?.[0]?.url ?? '';
    case 'images.1.url': return product.images?.nodes?.[1]?.url ?? '';
    case 'images.2.url': return product.images?.nodes?.[2]?.url ?? '';
    case 'variants.0.price': return product.variants?.nodes?.[0]?.price ?? '';
    case 'variants.0.compare_at_price': return product.variants?.nodes?.[0]?.compareAtPrice ?? '';
    case 'variants.0.sku': return product.variants?.nodes?.[0]?.sku ?? '';
    case 'variants.0.barcode': return product.variants?.nodes?.[0]?.barcode ?? '';
    case 'variants.0.inventory_quantity': return String(product.totalInventory ?? '');
    case 'variants.0.weight': return String(product.variants?.nodes?.[0]?.inventoryItem?.measurement?.weight?.value ?? '');
    default: return '';
  }
}

const SHOPIFY_FEED_PRODUCTS_QUERY = `
  query GetFeedProducts($cursor: String) {
    products(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id title handle vendor productType descriptionHtml tags status totalInventory
        images(first: 5) { nodes { url } }
        variants(first: 1) {
          nodes {
            price compareAtPrice sku barcode
            inventoryItem { measurement { weight { value unit } } }
          }
        }
      }
    }
  }
`;

async function fetchAllShopifyProductsForFeed(client: InstanceType<typeof ShopifyGraphQLClient>): Promise<any[]> {
  const all: any[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const result: any = await client.execute<any>(SHOPIFY_FEED_PRODUCTS_QUERY, { cursor });
    all.push(...(result.products?.nodes ?? []));
    cursor = result.products?.pageInfo?.hasNextPage ? (result.products.pageInfo.endCursor as string) : null;
    pages++;
  } while (cursor && pages < 40);
  return all;
}

// CRUD: list feeds
app.get('/feeds', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  const shopId = resolveActiveShopId(request, user ?? {});
  if (!shopId) return reply.code(400).send({ error: 'Connect a shop first' });
  const feeds = await prisma.feed.findMany({ where: { shopId }, orderBy: { createdAt: 'asc' } });
  return { feeds };
});

// CRUD: create feed
app.post('/feeds', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  const shopId = resolveActiveShopId(request, user ?? {});
  if (!shopId) return reply.code(400).send({ error: 'Connect a shop first' });
  const body = request.body as { name: string; feedType: string; format: string; mappingsJson: any[] };
  if (!body?.name) return reply.code(400).send({ error: 'name required' });
  const feed = await prisma.feed.create({
    data: {
      shopId,
      name: body.name,
      feedType: body.feedType ?? 'custom',
      format: body.format ?? 'xml',
      mappingsJson: body.mappingsJson ?? [],
    },
  });
  return { feed };
});

// CRUD: update feed
app.put('/feeds/:id', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  const shopId = resolveActiveShopId(request, user ?? {});
  if (!shopId) return reply.code(400).send({ error: 'Connect a shop first' });
  const existing = await prisma.feed.findFirst({ where: { id: request.params.id, shopId } });
  if (!existing) return reply.code(404).send({ error: 'Feed not found' });
  const body = request.body as Partial<{ name: string; feedType: string; format: string; mappingsJson: any[]; isActive: boolean }>;
  const feed = await prisma.feed.update({
    where: { id: existing.id },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.feedType !== undefined && { feedType: body.feedType }),
      ...(body.format !== undefined && { format: body.format }),
      ...(body.mappingsJson !== undefined && { mappingsJson: body.mappingsJson }),
      ...(body.isActive !== undefined && { isActive: body.isActive }),
    },
  });
  return { feed };
});

// CRUD: delete feed
app.delete('/feeds/:id', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  const shopId = resolveActiveShopId(request, user ?? {});
  if (!shopId) return reply.code(400).send({ error: 'Connect a shop first' });
  const existing = await prisma.feed.findFirst({ where: { id: request.params.id, shopId } });
  if (!existing) return reply.code(404).send({ error: 'Feed not found' });
  await prisma.feed.delete({ where: { id: existing.id } });
  return { ok: true };
});

// PUBLIC: serve feed by urlKey + urlSecret (no auth)
app.get('/feed/:key/:secret', async (request: any, reply) => {
  const feed = await prisma.feed.findUnique({ where: { urlKey: request.params.key } });
  if (!feed || !feed.isActive) return reply.code(404).send('Feed not found');
  if (feed.urlSecret !== request.params.secret) return reply.code(403).send('Invalid feed secret');

  const shop = await prisma.shop.findUnique({ where: { id: feed.shopId } });
  if (!shop) return reply.code(404).send('Shop not found');

  const token = decryptSecret(shop.encryptedAdminToken, env.MASTER_ENCRYPTION_KEY);
  const client = new ShopifyGraphQLClient({ storeUrl: shop.shopUrl, adminToken: token });

  let products: any[];
  try {
    products = await fetchAllShopifyProductsForFeed(client);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return reply.code(503).send(`Feed generation failed: ${msg}`);
  }

  const mappings = (feed.mappingsJson as Array<{ fieldName: string; source: string }>) ?? [];
  const shopUrl = shop.shopUrl.startsWith('http') ? shop.shopUrl : `https://${shop.shopUrl}`;

  if (feed.format === 'csv') {
    const header = mappings.map((m) => `"${m.fieldName.replace(/"/g, '""')}"`).join(',');
    const rows = products.map((p) =>
      mappings.map((m) => {
        const val = resolveFeedSource(m.source, p, shopUrl).replace(/"/g, '""');
        return `"${val}"`;
      }).join(','),
    );
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${feed.name.replace(/[^a-z0-9]/gi, '_')}.csv"`);
    return reply.send([header, ...rows].join('\n'));
  }

  // XML output
  const isGoogle = feed.feedType === 'google_shopping';
  const xmlItems = products.map((p) => {
    const fields = mappings.map((m) => {
      const val = resolveFeedSource(m.source, p, shopUrl);
      const tag = m.fieldName;
      return `    <${tag}><![CDATA[${val}]]></${tag}>`;
    }).join('\n');
    return `  <item>\n${fields}\n  </item>`;
  }).join('\n');

  let xml: string;
  if (isGoogle) {
    xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title><![CDATA[${shop.displayName ?? shop.shopUrl}]]></title>
    <link>${shopUrl}</link>
    <description>Google Shopping Feed — ${feed.name}</description>
${xmlItems}
  </channel>
</rss>`;
  } else {
    xml = `<?xml version="1.0" encoding="UTF-8"?>
<products>
${xmlItems}
</products>`;
  }

  reply.header('Content-Type', 'application/xml; charset=utf-8');
  return reply.send(xml);
});

// ──────────── Sync Runs ────────────

app.get('/export.csv', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  const shopId = resolveActiveShopId(request, user ?? {}) ?? user?.shopId ?? '';

  const PRODUCT_COLS = ['title', 'handle', 'vendor', 'productType', 'status'] as const;
  const VARIANT_COLS = ['sku', 'barcode', 'price', 'compareAtPrice', 'weight', 'weightUnit', 'hsCode', 'countryOfOrigin'] as const;
  const ALL_COLS = new Set([...PRODUCT_COLS, ...VARIANT_COLS]);

  const fieldsParam = (request.query.fields as string | undefined) ?? '';
  const requested = fieldsParam
    ? fieldsParam.split(',').map((f) => f.trim()).filter((f) => ALL_COLS.has(f as any))
    : ['title', 'sku', 'price'];
  const selected = requested.length ? requested : ['title', 'sku', 'price'];

  const pCols = PRODUCT_COLS.filter((f) => selected.includes(f));
  const vCols = VARIANT_COLS.filter((f) => selected.includes(f));

  const includeDrafts = (request.query.includeDrafts as string | undefined) === 'true';

  const products = await prisma.product.findMany({
    where: { shopId, shopifyDeletedAt: null },
    include: { variants: true },
    orderBy: { updatedAt: 'desc' },
  });

  // Apply pending drafts if requested
  type ProductRow = typeof products[number];
  let productMap: Map<string, ProductRow> = new Map(products.map((p) => [p.id, { ...p }]));
  if (includeDrafts) {
    const drafts = await prisma.draft.findMany({ where: { shopId, entityType: 'product' } });
    for (const draft of drafts) {
      const patch = draft.patchJson as Record<string, unknown>;
      const product = productMap.get(draft.entityId);
      if (product) {
        productMap.set(draft.entityId, { ...product, ...patch });
      }
    }
  }

  const esc = (v: unknown): string => {
    const s = v == null ? '' : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const header = ['productId', ...pCols, 'variantId', ...vCols].join(',');
  const lines = [header];

  for (const product of productMap.values()) {
    const pc = [esc(product.id), ...pCols.map((f) => esc((product as any)[f]))];
    const makeRow = (v: any) =>
      [...pc, esc(v?.id ?? ''), ...vCols.map((f) => esc(v?.[f]))].join(',');
    if (!product.variants.length) {
      lines.push(makeRow(null));
    } else {
      for (const v of product.variants) lines.push(makeRow(v));
    }
  }

  reply.header('Content-Type', 'text/csv; charset=utf-8');
  reply.header('Content-Disposition', 'attachment; filename="el-pim-export.csv"');
  return lines.join('\r\n');
});

const detectCsvSeparator = (csv: string): string => {
  const firstLine = csv.split('\n')[0] ?? '';
  const commas = (firstLine.match(/,/g) ?? []).length;
  const semicolons = (firstLine.match(/;/g) ?? []).length;
  return semicolons > commas ? ';' : ',';
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
    } else if (ch === sep && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
};

app.post('/import/analyze', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) return;

  const body = request.body as { csv?: string };
  if (!body?.csv?.trim()) return reply.code(400).send({ error: 'csv er påkrævet' });

  const apiKey = await getPlatformOpenAiKey();
  if (!apiKey) return reply.code(400).send({ error: 'OpenAI API key er ikke konfigureret. Kontakt platform-admin.' });

  const csv = body.csv.trim();
  const sep = detectCsvSeparator(csv);
  const lines = csv.split('\n').filter(Boolean);
  if (lines.length < 1) return reply.code(400).send({ error: 'CSV filen er tom' });

  const headers = parseCsvRow(lines[0] ?? '', sep);
  const sampleRows = lines.slice(1, 4).map((l) => parseCsvRow(l, sep));
  const rowCount = Math.max(0, lines.length - 1);

  const sampleTable = [headers, ...sampleRows].map((r) => r.join(' | ')).join('\n');

  const prompt = `Du er et CSV-analyse-system. Analyser headerne og eksempel-rækker fra denne CSV-fil og kortlæg kolonnerne til Shopify-produktfelter.

CSV-headere og eksempel (op til 3 rækker):
${sampleTable}

Tilgængelige felter:
- title: Produkttitel
- handle: URL-slug
- descriptionHtml: HTML-beskrivelse
- vendor: Leverandør/brand
- productType: Produkttype
- status: ACTIVE, DRAFT eller ARCHIVED
- tags: Kommaseparerede tags
- price: Pris (decimal, f.eks. 299.00)
- compareAtPrice: Sammenlign-pris
- sku: Varenummer/SKU
- barcode: Stregkode/EAN/GTIN
- weight: Vægt i gram
- shopifyId: Eksisterende Shopify-produkt-GID (gid://shopify/Product/...)
- ignore: Spring kolonne over

Svar KUN med valid JSON (ingen markdown, ingen forklaring):
{
  "columnMap": { "CSV_KOLONNE": "shopify_felt" },
  "unmappedColumns": [],
  "needsReview": false,
  "notes": ""
}

Regler:
- Alle CSV-kolonner SKAL have et felt (brug "ignore" hvis ingen match)
- "needsReview" = true hvis kolonner er tvetydige, bruger ikke-standard navne, eller en vigtig kolonne (title) ikke er kortlagt
- Returnér præcis de kolonnenavne der er i CSV'en`;

  try {
    const aiResp = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: env.OPENAI_MODEL, input: prompt, temperature: 0.1 }),
    });

    if (!aiResp.ok) {
      const errText = await aiResp.text();
      return reply.code(500).send({ error: `AI fejlede: ${aiResp.status} ${errText}` });
    }

    const aiJson = (await aiResp.json()) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    };

    const rawText = aiJson.output_text?.trim() ||
      aiJson.output?.flatMap((o) => o.content ?? []).find((c) => c.type === 'output_text')?.text?.trim() || '';

    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return reply.code(500).send({ error: 'AI returnerede ikke valid JSON' });

    const result = JSON.parse(jsonMatch[0]) as {
      columnMap?: Record<string, string>;
      unmappedColumns?: string[];
      needsReview?: boolean;
      notes?: string;
    };

    // Ensure every header has a mapping (fallback to 'ignore')
    const columnMap: Record<string, string> = {};
    for (const h of headers) {
      columnMap[h] = result.columnMap?.[h] ?? 'ignore';
    }

    const previewRows = sampleRows.map((row) =>
      Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ''])),
    );

    return {
      headers,
      separator: sep,
      rowCount,
      columnMap,
      needsReview: result.needsReview ?? true,
      notes: result.notes ?? '',
      previewRows,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return reply.code(500).send({ error: `AI analyse fejlede: ${msg}` });
  }
});

app.post('/import.csv', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) {
    return;
  }
  const body = request.body as { csv: string; columnMap?: Record<string, string> };
  if (!body?.csv) {
    return reply.code(400).send({ error: 'csv is required' });
  }
  const user = await getCurrentUser(request);
  const shopId = resolveActiveShopId(request, user ?? {});
  if (!shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  const type = body.columnMap ? 'import_csv_v2' : 'import_csv';
  const syncJob = await prisma.syncJob.create({
    data: {
      shopId,
      type,
      payloadJson: body as any,
      status: 'queued',
    },
  });
  await importQueue.add('import-csv', { syncJobId: syncJob.id }, { jobId: syncJob.id });

  return reply.code(202).send({ jobId: syncJob.id });
});

app.get('/import/:jobId/status', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  const shopId = resolveActiveShopId(request, user ?? {});
  if (!shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  const job = await prisma.syncJob.findFirst({ where: { id: request.params.jobId, shopId } });
  if (!job) {
    return reply.code(404).send({ error: 'Job not found' });
  }
  return { job };
});

app.get('/import/:jobId', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) return;

  const user = await getCurrentUser(request);
  const shopId = resolveActiveShopId(request, user ?? {});
  if (!shopId) return reply.code(400).send({ error: 'Connect a shop first' });

  const job = await prisma.syncJob.findFirst({ where: { id: request.params.jobId, shopId } });
  if (!job) return reply.code(404).send({ error: 'Job not found' });

  return { job };
});

app.get('/import/:jobId/report.csv', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  const shopId = resolveActiveShopId(request, user ?? {});
  if (!shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  const job = await prisma.syncJob.findFirst({ where: { id: request.params.jobId, shopId } });
  if (!job) {
    return reply.code(404).send({ error: 'Job not found' });
  }
  reply.header('Content-Type', 'text/csv');
  return `jobId,status,error\n${job.id},${job.status},${job.error ?? ''}`;
});

app.get('/warnings', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) {
    return;
  }
  const entityId = request.query.entityId as string;
  if (!entityId) {
    return reply.code(400).send({ error: 'entityId is required' });
  }

  const user = await getCurrentUser(request);
  const shopId = resolveActiveShopId(request, user ?? {});
  if (!shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  const ownedProduct = await prisma.product.findFirst({ where: { id: entityId, shopId }, select: { id: true, shopifyUpdatedAt: true } });
  const ownedVariant = ownedProduct
    ? null
    : await prisma.variant.findFirst({ where: { id: entityId, product: { shopId } }, select: { id: true, shopifyUpdatedAt: true } });

  if (!ownedProduct && !ownedVariant) {
    return reply.code(404).send({ error: 'Entity not found for current shop' });
  }

  // Use the entity's actual last Shopify update time for conflict detection
  const entityShopifyUpdatedAt = (ownedProduct ?? ownedVariant)?.shopifyUpdatedAt ?? null;

  const fieldValues = await prisma.fieldValue.findMany({
    where: { ownerId: entityId, fieldDefinition: { shopId } },
    include: { fieldDefinition: { include: { mapping: true } } },
  });

  const warnings = fieldValues.flatMap((fv: any) => {
    const result: Array<{ type: string; message: string; fieldDefinitionId: string }> = [];

    // Built-in fields (title, description, etc.) are always synced via hardcoded logic — no Mapping record needed
    if (!fv.fieldDefinition.mapping) {
      if (!fv.fieldDefinition.isBuiltIn) {
        result.push({
          type: 'mapping',
          message: 'Field has no Shopify mapping (allowed, but not syncable)',
          fieldDefinitionId: fv.fieldDefinitionId,
        });
      }
      return result;
    }

    const mapping = fv.fieldDefinition.mapping;

    if (mapping.direction === 'TWO_WAY' && entityShopifyUpdatedAt) {
      const resolution = resolveConflict(
        {
          direction: mapping.direction,
          conflictPolicy: mapping.conflictPolicy,
          conflictWindowMinutes: 10,
        },
        {
          pimChangedAt: fv.updatedAt,
          shopifyChangedAt: entityShopifyUpdatedAt,
        },
      );

      if (resolution.blocked) {
        result.push({
          type: 'conflict',
          message: resolution.warning ?? 'Two-way conflict',
          fieldDefinitionId: fv.fieldDefinitionId,
        });
      }
    }

    return result;
  });

  const conflictLogs = await prisma.changeLog.findMany({
    where: {
      shopId,
      entityId,
      source: 'conflict_hold',
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  for (let i = 0; i < conflictLogs.length; i++) {
    warnings.push({
      type: 'conflict',
      message: 'Ny Shopify-data holdt tilbage pga. lokale ændringer. Tag stilling før merge.',
      fieldDefinitionId: 'conflict_hold',
    });
  }

  return { warnings };
});

app.get('/changelog', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) {
    return;
  }
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  const shopId = resolveActiveShopId(request, user);
  if (!shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }
  const entityId = request.query.entityId as string | undefined;
  const logs = await prisma.changeLog.findMany({
    where: {
      shopId,
      ...(entityId ? { entityId } : {}),
    },
    include: {
      user: {
        select: { id: true, email: true, firstName: true, lastName: true },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return { logs };
});

app.get('/snapshots', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) {
    return;
  }
  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }
  const entityId = request.query.entityId as string | undefined;
  const snapshots = await prisma.snapshot.findMany({
    where: {
      shopId: user.shopId,
      ...(entityId ? { entityId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return { snapshots };
});

app.post('/snapshots/:id/restore', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  const snapshot = await prisma.snapshot.findFirst({ where: { id: request.params.id, shopId: user.shopId } });
  if (!snapshot) {
    return reply.code(404).send({ error: 'Snapshot not found' });
  }

  if (snapshot.entityType === 'product') {
    await prisma.product.update({
      where: { id: snapshot.entityId },
      data: snapshot.blobJson as any,
    });
  }
  if (snapshot.entityType === 'variant') {
    await prisma.variant.update({
      where: { id: snapshot.entityId },
      data: snapshot.blobJson as any,
    });
  }

  await prisma.changeLog.create({
    data: {
      shopId: snapshot.shopId,
      entityType: snapshot.entityType,
      entityId: snapshot.entityId,
      source: 'user',
      userId: request.user.id,
      afterJson: snapshot.blobJson as any,
    },
  });

  return { restored: true };
});

app.post('/ai/preview', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const parsed = aiPreviewSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }

  const generated = parsed.data.rows.map((row) => ({
    ...row,
    value: `AI suggestion for ${row.ownerType}:${row.ownerId} using template ${parsed.data.promptTemplate.slice(0, 50)}`,
  }));

  return { generated };
});

app.post('/ai/keywords/suggest', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const parsed = aiKeywordSuggestionSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }

  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }
  const platformOpenAiKey = await getPlatformOpenAiKey();
  if (!platformOpenAiKey) {
    return reply.code(400).send({ error: 'OpenAI API key er ikke konfigureret. Kontakt platform-admin.' });
  }

  const product = await prisma.product.findUnique({
    where: { id: parsed.data.productId },
    include: { variants: true },
  });
  if (!product) {
    return reply.code(404).send({ error: 'Product not found.' });
  }
  if (product.shopId !== user.shopId) {
    return reply.code(403).send({ error: 'Forbidden product access.' });
  }

  const competitorDomains = parsed.data.competitorUrls
    .map((url) => {
      try {
        return new URL(url).hostname.replace(/^www\./, '');
      } catch {
        return null;
      }
    })
    .filter((value): value is string => Boolean(value));

  const prompt = `Du er en senior SEO specialist for dansk e-commerce.

Find de mest relevante søgeord for produktet herunder med fokus på høj trafik og høj relevans.
Du skal prioritere søgeord, som realistisk kan bruges i titel, beskrivelse, FAQ og kategoritekst.

Produktdata:
- titel: ${product.title}
- handle: ${product.handle}
- vendor: ${product.vendor ?? ''}
- beskrivelse: ${product.descriptionHtml ?? ''}
- sku: ${product.variants?.[0]?.sku ?? ''}
- barcode: ${product.variants?.[0]?.barcode ?? ''}

Sprog/marked: ${parsed.data.locale}

Konkurrent-domæner (research disse aktivt):
${competitorDomains.length ? competitorDomains.map((domain) => `- ${domain}`).join('\n') : '- ingen angivet'}

Returnér KUN valid JSON med dette format:
{
  "suggestions": [
    {
      "keyword": "...",
      "intent": "commercial|informational|transactional",
      "trafficPotential": "high|medium|low",
      "reason": "kort begrundelse"
    }
  ]
}

Maks antal forslag: ${parsed.data.maxSuggestions}.`;

  const openAiApiKey = platformOpenAiKey;

  const executeRequest = async (withWebSearch: boolean): Promise<Response> => {
    const body: Record<string, unknown> = {
      model: env.OPENAI_MODEL,
      input: prompt,
      temperature: 0.4,
    };
    if (withWebSearch) {
      body.tools = [{ type: 'web_search_preview' }];
    }

    return fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openAiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  };

  let response = await executeRequest(true);
  if (!response.ok) {
    response = await executeRequest(false);
  }
  if (!response.ok) {
    const text = await response.text();
    return reply.code(502).send({ error: `OpenAI request failed: ${response.status} ${text}` });
  }

  const json = (await response.json()) as {
    output_text?: string;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  };

  const rawText =
    (json.output_text ?? '').trim() ||
    json.output
      ?.flatMap((item) => item.content ?? [])
      .find((content) => content.type === 'output_text' && content.text)
      ?.text?.trim() ||
    '';

  if (!rawText) {
    return reply.code(502).send({ error: 'OpenAI returned no keyword suggestions.' });
  }

  let suggestions: Array<{ keyword: string; intent: string; trafficPotential: string; reason: string }> = [];
  try {
    const jsonText = extractJsonObjectText(rawText) ?? rawText;
    const parsedOutput = JSON.parse(jsonText) as {
      suggestions?: Array<{ keyword?: string; intent?: string; trafficPotential?: string; reason?: string }>;
    };
    suggestions = (parsedOutput.suggestions ?? [])
      .map((item) => ({
        keyword: (item.keyword ?? '').trim(),
        intent: (item.intent ?? 'commercial').trim(),
        trafficPotential: (item.trafficPotential ?? 'medium').trim(),
        reason: (item.reason ?? '').trim(),
      }))
      .filter((item) => item.keyword.length > 0)
      .slice(0, parsed.data.maxSuggestions);
  } catch {
    const quotedKeywords = Array.from(rawText.matchAll(/"keyword"\s*:\s*"([^"]+)"/gi)).map((match) => match[1]?.trim()).filter(Boolean);
    const fallbackKeywords = quotedKeywords.length
      ? quotedKeywords
      : rawText
      .split('\n')
      .flatMap((line) => line.split(','))
      .map((line) => line.replace(/^[-*\d.\s]+/, '').trim())
      .filter((line) => line.length > 2)
      .filter((line) => !/^(json|suggestions|keyword|intent|trafficPotential|reason)$/i.test(line))
      .filter(Boolean)
      .slice(0, parsed.data.maxSuggestions);

    suggestions = fallbackKeywords
      .map((keyword) => ({
        keyword,
        intent: 'commercial',
        trafficPotential: 'medium',
        reason: 'Udledt fra model-output.',
      }));
  }

  const promptTokens = Number(json.usage?.input_tokens ?? 0);
  const completionTokens = Number(json.usage?.output_tokens ?? 0);
  const totalTokens = Number(json.usage?.total_tokens ?? promptTokens + completionTokens);
  const costs = estimateOpenAiCost(promptTokens, completionTokens);

  if (user.shopId) {
    await prisma.aiUsage.create({
      data: {
        shopId: user.shopId,
        productId: product.id,
        userId: user.id,
        feature: 'keyword_suggestion',
        provider: 'openai',
        model: env.OPENAI_MODEL,
        promptTokens,
        completionTokens,
        totalTokens,
        estimatedCostUsd: costs.usd,
        estimatedCostDkk: costs.dkk,
        metadataJson: {
          competitorDomains,
          suggestionCount: suggestions.length,
        },
      },
    });
  }

  return {
    suggestions,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens,
      estimatedCostDkk: costs.dkk,
      estimatedCostUsd: costs.usd,
    },
  };
});

app.post('/ai/apply', async (request: any, reply) => {
  if (!(await withAuth(request, reply))) {
    return;
  }

  const parsed = aiPreviewSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send(parsed.error.flatten());
  }

  const user = await getCurrentUser(request);
  if (!user?.shopId) {
    return reply.code(400).send({ error: 'Connect a shop first' });
  }

  const field = await prisma.fieldDefinition.findFirst({
    where: { id: parsed.data.fieldDefinitionId, shopId: user.shopId },
    select: { id: true },
  });
  if (!field) {
    return reply.code(400).send({ error: 'Selected field does not belong to current shop' });
  }

  const productIds = parsed.data.rows.filter((row) => row.ownerType === 'product').map((row) => row.ownerId);
  const variantIds = parsed.data.rows.filter((row) => row.ownerType === 'variant').map((row) => row.ownerId);
  const collectionIds = parsed.data.rows.filter((row) => row.ownerType === 'collection').map((row) => row.ownerId);

  if (productIds.length > 0) {
    const ownedProducts = await prisma.product.count({ where: { id: { in: productIds }, shopId: user.shopId } });
    if (ownedProducts !== productIds.length) {
      return reply.code(400).send({ error: 'One or more selected products do not belong to current shop' });
    }
  }

  if (variantIds.length > 0) {
    const ownedVariants = await prisma.variant.count({
      where: { id: { in: variantIds }, product: { shopId: user.shopId } },
    });
    if (ownedVariants !== variantIds.length) {
      return reply.code(400).send({ error: 'One or more selected variants do not belong to current shop' });
    }
  }

  if (collectionIds.length > 0) {
    const ownedCollections = await prisma.collection.count({ where: { id: { in: collectionIds }, shopId: user.shopId } });
    if (ownedCollections !== collectionIds.length) {
      return reply.code(400).send({ error: 'One or more selected collections do not belong to current shop' });
    }
  }

  const job = await prisma.syncJob.create({
    data: {
      shopId: user.shopId,
      type: 'ai_apply',
      payloadJson: parsed.data,
      status: 'queued',
    },
  });
  await aiQueue.add('ai-apply', { syncJobId: job.id, userId: request.user.id }, { jobId: job.id });

  return reply.code(202).send({ jobId: job.id });
});

app.post('/ai/jobs/:jobId/cancel', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user?.shopId) return reply.code(400).send({ error: 'Connect a shop first' });

  const job = await prisma.syncJob.findFirst({
    where: { id: request.params.jobId, shopId: user.shopId, type: 'ai_apply' },
    select: { id: true, status: true, payloadJson: true },
  });
  if (!job) return reply.code(404).send({ error: 'Job not found' });
  if (job.status === 'done' || job.status === 'failed') {
    return reply.code(400).send({ error: 'Job already finished' });
  }

  const payload = (job.payloadJson ?? {}) as Record<string, unknown>;
  await prisma.syncJob.update({
    where: { id: job.id },
    data: { payloadJson: { ...payload, cancelRequested: true } },
  });

  return { ok: true };
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN — Users
// ══════════════════════════════════════════════════════════════════════════════

app.get('/admin/users', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  if (!hasPlatformGlobalAccess(user.platformRole)) return reply.code(403).send({ error: 'Platform admin/support role required' });

  const q = typeof request.query.q === 'string' ? request.query.q.trim() : '';
  const platform = request.query.platformRole as string | undefined;
  const page = Math.max(1, Number(request.query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));

  const where: any = {
    ...(q ? { email: { contains: q, mode: 'insensitive' } } : {}),
    ...(platform && platform !== 'all' ? { platformRole: platform } : {}),
  };

  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        title: true,
        role: true,
        platformRole: true,
        createdAt: true,
        organizationMemberships: { select: { id: true, role: true, organization: { select: { id: true, name: true, type: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return { total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)), users };
});

app.post('/admin/users', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const parsed = adminCreateUserSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  if (!hasPlatformGlobalAccess(user.platformRole)) return reply.code(403).send({ error: 'Platform admin/support role required' });

  const existing = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (existing) return reply.code(409).send({ error: 'Email already registered' });

  const newUser = await prisma.user.create({
    data: {
      email: parsed.data.email,
      passwordHash: await hashPassword(parsed.data.password),
      firstName: parsed.data.firstName ?? null,
      lastName: parsed.data.lastName ?? null,
      title: parsed.data.title ?? null,
      role: 'member',
      platformRole: parsed.data.platformRole,
    },
    select: { id: true, email: true, firstName: true, lastName: true, title: true, role: true, platformRole: true, createdAt: true },
  });

  await createBillingOpsAudit({ userId: user.id, action: 'admin_user_create', targetType: 'user', targetId: newUser.id, metadataJson: { email: newUser.email } });
  return reply.code(201).send({ user: newUser });
});

app.get('/admin/users/:id', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  if (!hasPlatformGlobalAccess(user.platformRole)) return reply.code(403).send({ error: 'Platform admin/support role required' });

  const target = await prisma.user.findUnique({
    where: { id: request.params.id },
    select: {
      id: true, email: true, firstName: true, lastName: true, title: true, role: true, platformRole: true, createdAt: true,
      organizationMemberships: { select: { id: true, role: true, organization: { select: { id: true, name: true, type: true } } } },
      shopMemberships: { select: { role: true, shop: { select: { id: true, shopUrl: true } } } },
    },
  });
  if (!target) return reply.code(404).send({ error: 'User not found' });
  return { user: target };
});

app.patch('/admin/users/:id', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const parsed = adminPatchUserSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  if (!hasPlatformGlobalAccess(user.platformRole)) return reply.code(403).send({ error: 'Platform admin/support role required' });

  const target = await prisma.user.findUnique({ where: { id: request.params.id }, select: { id: true } });
  if (!target) return reply.code(404).send({ error: 'User not found' });

  const dataUpdate: any = {};
  if (parsed.data.email !== undefined) dataUpdate.email = parsed.data.email;
  if (parsed.data.platformRole !== undefined) dataUpdate.platformRole = parsed.data.platformRole;
  if (parsed.data.firstName !== undefined) dataUpdate.firstName = parsed.data.firstName;
  if (parsed.data.lastName !== undefined) dataUpdate.lastName = parsed.data.lastName;
  if (parsed.data.title !== undefined) dataUpdate.title = parsed.data.title;
  if (parsed.data.password) dataUpdate.passwordHash = await hashPassword(parsed.data.password);

  const updated = await prisma.user.update({
    where: { id: request.params.id },
    data: dataUpdate,
    select: { id: true, email: true, firstName: true, lastName: true, title: true, role: true, platformRole: true },
  });

  const auditMeta: any = { ...parsed.data };
  delete auditMeta.password;
  if (parsed.data.password) auditMeta.passwordChanged = true;
  if (parsed.data.sendPasswordNotification) auditMeta.notificationRequested = true;
  await createBillingOpsAudit({ userId: user.id, action: 'admin_user_update', targetType: 'user', targetId: updated.id, metadataJson: auditMeta });
  return { user: updated };
});

// Admin: add user to organization
app.post('/admin/users/:id/org-memberships', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const parsed = adminUserOrgMembershipSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  if (!hasPlatformGlobalAccess(user.platformRole)) return reply.code(403).send({ error: 'Platform admin/support role required' });

  const target = await prisma.user.findUnique({ where: { id: request.params.id }, select: { id: true } });
  if (!target) return reply.code(404).send({ error: 'User not found' });
  const org = await prisma.organization.findUnique({ where: { id: parsed.data.organizationId }, select: { id: true, name: true } });
  if (!org) return reply.code(404).send({ error: 'Organization not found' });

  const membership = await prisma.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: parsed.data.organizationId, userId: request.params.id } },
    update: { role: parsed.data.role },
    create: { organizationId: parsed.data.organizationId, userId: request.params.id, role: parsed.data.role },
    select: { id: true, role: true, organization: { select: { id: true, name: true, type: true } } },
  });

  await createBillingOpsAudit({ userId: user.id, action: 'admin_user_org_add', targetType: 'user', targetId: target.id, metadataJson: { orgId: org.id, orgName: org.name, role: parsed.data.role } });
  return reply.code(201).send({ membership });
});

// Admin: remove user from organization
app.delete('/admin/users/:id/org-memberships/:membershipId', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  if (!hasPlatformGlobalAccess(user.platformRole)) return reply.code(403).send({ error: 'Platform admin/support role required' });

  const membership = await prisma.organizationMembership.findFirst({
    where: { id: request.params.membershipId, userId: request.params.id },
    select: { id: true, organizationId: true },
  });
  if (!membership) return reply.code(404).send({ error: 'Membership not found' });

  await prisma.organizationMembership.delete({ where: { id: membership.id } });
  await createBillingOpsAudit({ userId: user.id, action: 'admin_user_org_remove', targetType: 'user', targetId: request.params.id, metadataJson: { membershipId: membership.id, orgId: membership.organizationId } });
  return { ok: true };
});

app.delete('/admin/users/:id', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  if (!hasPlatformGlobalAccess(user.platformRole)) return reply.code(403).send({ error: 'Platform admin/support role required' });
  if (request.params.id === user.id) return reply.code(400).send({ error: 'Cannot delete yourself' });

  const target = await prisma.user.findUnique({ where: { id: request.params.id }, select: { id: true, email: true } });
  if (!target) return reply.code(404).send({ error: 'User not found' });

  await prisma.$transaction([
    prisma.organizationMembership.deleteMany({ where: { userId: target.id } }),
    prisma.shopMembership.deleteMany({ where: { userId: target.id } }),
    prisma.user.delete({ where: { id: target.id } }),
  ]);

  await createBillingOpsAudit({ userId: user.id, action: 'admin_user_delete', targetType: 'user', targetId: target.id, metadataJson: { email: target.email } });
  return { ok: true };
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN — Organizations
// ══════════════════════════════════════════════════════════════════════════════

app.get('/admin/organizations', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  if (!hasPlatformGlobalAccess(user.platformRole)) return reply.code(403).send({ error: 'Platform admin/support role required' });

  const q = typeof request.query.q === 'string' ? request.query.q.trim() : '';
  const typeFilter = request.query.type as string | undefined;
  const page = Math.max(1, Number(request.query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));

  const where: any = {
    ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { cvrNumber: { contains: q } }] } : {}),
    ...(typeFilter && typeFilter !== 'all' ? { type: typeFilter } : {}),
  };

  const [total, orgs] = await Promise.all([
    prisma.organization.count({ where }),
    prisma.organization.findMany({
      where,
      include: {
        memberships: { select: { role: true, user: { select: { id: true, email: true } } } },
        shops: { select: { id: true, shopUrl: true, status: true } },
        _count: { select: { agencyRelations: true, clientRelations: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return { total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)), organizations: orgs };
});

app.post('/admin/organizations', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const parsed = adminCreateOrgSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  if (!hasPlatformGlobalAccess(user.platformRole)) return reply.code(403).send({ error: 'Platform admin/support role required' });

  const existing = await prisma.organization.findUnique({ where: { cvrNumber: parsed.data.cvrNumber } });
  if (existing) return reply.code(409).send({ error: 'En organisation med dette CVR-nummer eksisterer allerede' });

  let resolvedName = parsed.data.name;
  let resolvedAddress = parsed.data.address;

  if (!resolvedName || !resolvedAddress) {
    const cvrData = await lookupCvr(parsed.data.cvrNumber);
    if (!resolvedName && cvrData?.name) resolvedName = cvrData.name;
    if (!resolvedAddress && cvrData?.address) resolvedAddress = cvrData.address;
  }

  if (!resolvedName) {
    return reply.code(422).send({ error: 'Kunne ikke slå CVR-nummer op. Angiv venligst firmanavn manuelt.' });
  }

  const org = await prisma.organization.create({
    data: {
      cvrNumber: parsed.data.cvrNumber,
      name: resolvedName,
      address: resolvedAddress ?? null,
      type: parsed.data.type,
    },
  });

  await createBillingOpsAudit({ userId: user.id, action: 'admin_org_create', targetType: 'organization', targetId: org.id, metadataJson: { cvrNumber: org.cvrNumber, name: org.name } });
  return reply.code(201).send({ organization: org });
});

app.get('/admin/organizations/:id', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  if (!hasPlatformGlobalAccess(user.platformRole)) return reply.code(403).send({ error: 'Platform admin/support role required' });

  const org = await prisma.organization.findUnique({
    where: { id: request.params.id },
    include: {
      memberships: { select: { id: true, role: true, user: { select: { id: true, email: true, platformRole: true } } } },
      shops: { include: { subscription: { select: { status: true } }, memberships: { select: { userId: true, role: true } } } },
      agencyRelations: { include: { clientOrg: { select: { id: true, name: true, cvrNumber: true } } } },
      clientRelations: { include: { agencyOrg: { select: { id: true, name: true, cvrNumber: true } } } },
    },
  });
  if (!org) return reply.code(404).send({ error: 'Organization not found' });
  return { organization: org };
});

app.patch('/admin/organizations/:id', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const parsed = adminPatchOrgSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  if (!hasPlatformGlobalAccess(user.platformRole)) return reply.code(403).send({ error: 'Platform admin/support role required' });

  const org = await prisma.organization.findUnique({ where: { id: request.params.id }, select: { id: true } });
  if (!org) return reply.code(404).send({ error: 'Organization not found' });

  const updated = await prisma.organization.update({
    where: { id: request.params.id },
    data: { ...parsed.data },
  });

  await createBillingOpsAudit({ userId: user.id, action: 'admin_org_update', targetType: 'organization', targetId: updated.id, metadataJson: parsed.data });
  return { organization: updated };
});

app.delete('/admin/organizations/:id', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  if (!hasPlatformGlobalAccess(user.platformRole)) return reply.code(403).send({ error: 'Platform admin/support role required' });

  const org = await prisma.organization.findUnique({ where: { id: request.params.id }, select: { id: true, name: true, shops: { select: { id: true } } } });
  if (!org) return reply.code(404).send({ error: 'Organization not found' });
  if (org.shops.length > 0) return reply.code(409).send({ error: 'Org har tilknyttede webshops — fjern dem først' });

  await prisma.$transaction([
    prisma.organizationMembership.deleteMany({ where: { organizationId: org.id } }),
    prisma.agencyClientRelation.deleteMany({ where: { OR: [{ agencyOrgId: org.id }, { clientOrgId: org.id }] } }),
    prisma.organization.delete({ where: { id: org.id } }),
  ]);

  await createBillingOpsAudit({ userId: user.id, action: 'admin_org_delete', targetType: 'organization', targetId: org.id, metadataJson: { name: org.name } });
  return { ok: true };
});

app.post('/admin/organizations/:id/members', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const parsed = orgMemberSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  if (!hasPlatformGlobalAccess(user.platformRole)) return reply.code(403).send({ error: 'Platform admin/support role required' });

  const org = await prisma.organization.findUnique({ where: { id: request.params.id }, select: { id: true } });
  if (!org) return reply.code(404).send({ error: 'Organization not found' });
  const target = await prisma.user.findUnique({ where: { id: parsed.data.userId }, select: { id: true } });
  if (!target) return reply.code(404).send({ error: 'User not found' });

  const membership = await prisma.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: org.id, userId: parsed.data.userId } },
    update: { role: parsed.data.role },
    create: { organizationId: org.id, userId: parsed.data.userId, role: parsed.data.role },
  });

  return reply.code(201).send({ membership });
});

app.patch('/admin/organizations/:id/members/:userId', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const parsed = orgMemberPatchSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  if (!hasPlatformGlobalAccess(user.platformRole)) return reply.code(403).send({ error: 'Platform admin/support role required' });

  const membership = await prisma.organizationMembership.update({
    where: { organizationId_userId: { organizationId: request.params.id, userId: request.params.userId } },
    data: { role: parsed.data.role },
  });
  return { membership };
});

app.delete('/admin/organizations/:id/members/:userId', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  if (!hasPlatformGlobalAccess(user.platformRole)) return reply.code(403).send({ error: 'Platform admin/support role required' });

  await prisma.organizationMembership.delete({
    where: { organizationId_userId: { organizationId: request.params.id, userId: request.params.userId } },
  });
  return { ok: true };
});

app.post('/admin/organizations/:id/shops/:shopId/members', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const parsed = shopAccessGrantSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  if (!hasPlatformGlobalAccess(user.platformRole)) return reply.code(403).send({ error: 'Platform admin/support role required' });

  const shop = await prisma.shop.findFirst({ where: { id: request.params.shopId, organizationId: request.params.id }, select: { id: true } });
  if (!shop) return reply.code(404).send({ error: 'Shop not found in this organization' });
  const target = await prisma.user.findUnique({ where: { id: parsed.data.userId }, select: { id: true } });
  if (!target) return reply.code(404).send({ error: 'User not found' });

  const membership = await prisma.shopMembership.upsert({
    where: { shopId_userId: { shopId: shop.id, userId: parsed.data.userId } },
    update: { role: 'member' },
    create: { shopId: shop.id, userId: parsed.data.userId, role: 'member' },
  });
  return reply.code(201).send({ membership });
});

app.delete('/admin/organizations/:id/shops/:shopId/members/:userId', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  if (!hasPlatformGlobalAccess(user.platformRole)) return reply.code(403).send({ error: 'Platform admin/support role required' });

  await prisma.shopMembership.delete({
    where: { shopId_userId: { shopId: request.params.shopId, userId: request.params.userId } },
  });
  return { ok: true };
});

// ══════════════════════════════════════════════════════════════════════════════
// PLATFORM BANNER
// ══════════════════════════════════════════════════════════════════════════════

type BannerPayload = {
  active: boolean;
  type: 'info' | 'warning' | 'error' | 'maintenance' | 'critical';
  title: string | null;
  message: string;
};

const bannerSchema = z.object({
  active: z.boolean(),
  type: z.enum(['info', 'warning', 'error', 'maintenance', 'critical']),
  title: z.string().nullable().optional(),
  message: z.string(),
});

app.get('/platform/banner', async (_request: any, reply: any) => {
  const row = await prisma.platformSetting.findUnique({ where: { key: 'announcement_banner' } });
  if (!row?.valueJson) return reply.send({ banner: null });
  const data = row.valueJson as BannerPayload;
  if (!data.active) return reply.send({ banner: null });
  return reply.send({ banner: data });
});

app.put('/admin/banner', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  if (!hasPlatformGlobalAccess(user.platformRole)) return reply.code(403).send({ error: 'Platform admin/support role required' });

  const parsed = bannerSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());

  const data: BannerPayload = {
    active: parsed.data.active,
    type: parsed.data.type,
    title: parsed.data.title ?? null,
    message: parsed.data.message,
  };

  await prisma.platformSetting.upsert({
    where: { key: 'announcement_banner' },
    update: { valueJson: data as any },
    create: { key: 'announcement_banner', valueJson: data as any },
  });

  return { ok: true, banner: data };
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN — Agencies
// ══════════════════════════════════════════════════════════════════════════════

app.get('/admin/agencies', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  if (!hasPlatformGlobalAccess(user.platformRole)) return reply.code(403).send({ error: 'Platform admin/support role required' });

  const page = Math.max(1, Number(request.query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));

  const typeFilter = request.query.type as string | undefined;
  const agencyWhere: any = typeFilter && typeFilter !== 'all'
    ? { type: typeFilter }
    : { OR: [{ type: 'agency' }, { agencyRelations: { some: {} } }] };

  const [total, agencies] = await Promise.all([
    prisma.organization.count({ where: agencyWhere }),
    prisma.organization.findMany({
      where: agencyWhere,
      include: {
        memberships: { select: { role: true, user: { select: { id: true, email: true } } } },
        agencyRelations: {
          include: { clientOrg: { select: { id: true, name: true, cvrNumber: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return { total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)), agencies };
});

app.post('/admin/agencies/:agencyId/relations', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const parsed = agencyRelationCreateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  if (!hasPlatformGlobalAccess(user.platformRole)) return reply.code(403).send({ error: 'Platform admin/support role required' });

  const agency = await prisma.organization.findUnique({ where: { id: request.params.agencyId }, select: { id: true } });
  if (!agency) return reply.code(404).send({ error: 'Organization not found' });
  const client = await prisma.organization.findUnique({ where: { id: parsed.data.clientOrgId }, select: { id: true } });
  if (!client) return reply.code(404).send({ error: 'Client organization not found' });
  if (parsed.data.clientOrgId === request.params.agencyId) return reply.code(400).send({ error: 'Agency og klient må ikke være den samme organisation' });

  // Generate unique referral code
  let referralCode = generateReferralCode();
  let attempts = 0;
  while (attempts < 10) {
    const exists = await prisma.agencyClientRelation.findUnique({ where: { referralCode } });
    if (!exists) break;
    referralCode = generateReferralCode();
    attempts++;
  }

  const relation = await prisma.agencyClientRelation.upsert({
    where: { agencyOrgId_clientOrgId: { agencyOrgId: request.params.agencyId, clientOrgId: parsed.data.clientOrgId } },
    update: { status: 'active', commissionRateBps: parsed.data.commissionRateBps },
    create: {
      agencyOrgId: request.params.agencyId,
      clientOrgId: parsed.data.clientOrgId,
      referralCode,
      commissionRateBps: parsed.data.commissionRateBps,
    },
  });

  await createBillingOpsAudit({ userId: user.id, action: 'admin_agency_relation_create', targetType: 'agency_relation', targetId: relation.id, metadataJson: { agencyId: request.params.agencyId, clientOrgId: parsed.data.clientOrgId } });
  return reply.code(201).send({ relation });
});

app.get('/admin/agencies/:agencyId/relations', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  if (!hasPlatformGlobalAccess(user.platformRole)) return reply.code(403).send({ error: 'Platform admin/support role required' });

  const relations = await prisma.agencyClientRelation.findMany({
    where: { agencyOrgId: request.params.agencyId },
    include: {
      clientOrg: { select: { id: true, name: true, cvrNumber: true, shops: { select: { id: true, shopUrl: true, status: true } } } },
      commissions: { select: { id: true, billingMonth: true, commissionMinor: true, status: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  return { relations };
});

app.patch('/admin/agencies/:agencyId/relations/:id', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const parsed = agencyRelationPatchSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  if (!hasPlatformGlobalAccess(user.platformRole)) return reply.code(403).send({ error: 'Platform admin/support role required' });

  const relation = await prisma.agencyClientRelation.findFirst({ where: { id: request.params.id, agencyOrgId: request.params.agencyId } });
  if (!relation) return reply.code(404).send({ error: 'Relation not found' });

  const updated = await prisma.agencyClientRelation.update({
    where: { id: relation.id },
    data: { ...parsed.data },
  });

  await createBillingOpsAudit({ userId: user.id, action: 'admin_agency_relation_update', targetType: 'agency_relation', targetId: relation.id, metadataJson: parsed.data });
  return { relation: updated };
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN — Referral Commissions & Payouts
// ══════════════════════════════════════════════════════════════════════════════

app.get('/admin/referrals', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  if (!hasPlatformGlobalAccess(user.platformRole)) return reply.code(403).send({ error: 'Platform admin/support role required' });

  const page = Math.max(1, Number(request.query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));
  const statusFilter = request.query.status as string | undefined;

  const where: any = statusFilter && statusFilter !== 'all' ? { status: statusFilter } : {};

  const [total, commissions] = await Promise.all([
    prisma.referralCommission.count({ where }),
    prisma.referralCommission.findMany({
      where,
      include: {
        agencyOrg: { select: { id: true, name: true, type: true } },
        agencyRelation: { select: { clientOrg: { select: { id: true, name: true } } } },
        shop: { select: { id: true, shopUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return { total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)), commissions };
});

app.get('/admin/referral-payouts', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  if (!hasPlatformGlobalAccess(user.platformRole)) return reply.code(403).send({ error: 'Platform admin/support role required' });

  const page = Math.max(1, Number(request.query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));
  const statusFilter = request.query.status as string | undefined;

  const where: any = statusFilter && statusFilter !== 'all' ? { status: statusFilter } : {};

  const [total, payouts] = await Promise.all([
    prisma.referralPayoutRequest.count({ where }),
    prisma.referralPayoutRequest.findMany({
      where,
      include: {
        agencyOrg: { select: { id: true, name: true } },
        commissions: { select: { id: true, billingMonth: true, commissionMinor: true, shopId: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return { total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)), payouts };
});

app.patch('/admin/referral-payouts/:id', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const parsed = payoutStatusSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  if (!hasPlatformGlobalAccess(user.platformRole)) return reply.code(403).send({ error: 'Platform admin/support role required' });

  const payout = await prisma.referralPayoutRequest.findUnique({ where: { id: request.params.id } });
  if (!payout) return reply.code(404).send({ error: 'Payout request not found' });

  const updated = await prisma.referralPayoutRequest.update({
    where: { id: payout.id },
    data: { status: parsed.data.status, adminNote: parsed.data.adminNote ?? payout.adminNote },
  });

  if (parsed.data.status === 'paid') {
    await prisma.referralCommission.updateMany({
      where: { payoutRequestId: payout.id },
      data: { status: 'paid' },
    });
  }

  await createBillingOpsAudit({ userId: user.id, action: 'admin_payout_status_update', targetType: 'referral_payout', targetId: payout.id, metadataJson: { status: parsed.data.status } });
  return { payout: updated };
});

// ══════════════════════════════════════════════════════════════════════════════
// SELF-SERVICE — Organization members & shop access (org admin/owner)
// ══════════════════════════════════════════════════════════════════════════════

// moved to invitation section below — GET /organizations/:id/members

app.post('/organizations/:id/members', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const parsed = orgMemberSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });

  const allowed = await ensureOrgAccess({ user, orgId: request.params.id, minRole: 'admin' });
  if (!allowed) return reply.code(403).send({ error: 'Org admin or owner role required' });

  const target = await prisma.user.findUnique({ where: { id: parsed.data.userId }, select: { id: true } });
  if (!target) return reply.code(404).send({ error: 'User not found' });

  const membership = await prisma.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: request.params.id, userId: parsed.data.userId } },
    update: { role: parsed.data.role },
    create: { organizationId: request.params.id, userId: parsed.data.userId, role: parsed.data.role },
  });

  return reply.code(201).send({ membership });
});

app.patch('/organizations/:id/members/:userId', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const parsed = orgMemberPatchSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });

  const allowed = await ensureOrgAccess({ user, orgId: request.params.id, minRole: 'owner' });
  if (!allowed) return reply.code(403).send({ error: 'Org owner role required' });

  const membership = await prisma.organizationMembership.update({
    where: { organizationId_userId: { organizationId: request.params.id, userId: request.params.userId } },
    data: { role: parsed.data.role },
  });
  return { membership };
});

app.delete('/organizations/:id/members/:userId', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });
  if (request.params.userId === user.id) return reply.code(400).send({ error: 'Cannot remove yourself' });

  const allowed = await ensureOrgAccess({ user, orgId: request.params.id, minRole: 'admin' });
  if (!allowed) return reply.code(403).send({ error: 'Org admin or owner role required' });

  await prisma.organizationMembership.delete({
    where: { organizationId_userId: { organizationId: request.params.id, userId: request.params.userId } },
  });
  return { ok: true };
});

app.get('/organizations/:id/shops', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid.' });

  const allowed = await ensureOrgAccess({ user, orgId: request.params.id });
  if (!allowed) return reply.code(403).send({ error: 'Org membership required' });

  const shops = await prisma.shop.findMany({
    where: { organizationId: request.params.id },
    select: {
      id: true,
      shopUrl: true,
      displayName: true,
      status: true,
      createdAt: true,
      subscription: {
        select: { status: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  return reply.send({ shops });
});

app.delete('/organizations/:id/shops/:shopId', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid.' });

  const allowed = await ensureOrgAccess({ user, orgId: request.params.id, minRole: 'admin' });
  if (!allowed) return reply.code(403).send({ error: 'Org admin eller owner rolle påkrævet.' });

  const shop = await prisma.shop.findFirst({
    where: { id: request.params.shopId, organizationId: request.params.id },
    select: { id: true, shopUrl: true, status: true },
  });
  if (!shop) return reply.code(404).send({ error: 'Webshop ikke fundet.' });
  if (shop.status !== 'disconnected') return reply.code(400).send({ error: 'Webshop skal være frakoblet, før den kan slettes.' });

  const body = request.body as { confirmShopUrl?: string };
  if (body.confirmShopUrl?.trim() !== shop.shopUrl) {
    return reply.code(400).send({ error: 'Bekræftelse mislykkedes: shop URL matcher ikke.' });
  }

  const fieldDefIds = (await prisma.fieldDefinition.findMany({ where: { shopId: shop.id }, select: { id: true } })).map((f) => f.id);

  await prisma.usageEvent.deleteMany({ where: { shopId: shop.id } });
  await prisma.usageNotice.deleteMany({ where: { shopId: shop.id } });
  await prisma.billingLedgerMonth.deleteMany({ where: { shopId: shop.id } });
  await prisma.aiUsage.deleteMany({ where: { shopId: shop.id } });
  await prisma.shopSetting.deleteMany({ where: { shopId: shop.id } });
  await prisma.sourceDataRow.deleteMany({ where: { shopId: shop.id } });
  await prisma.source.deleteMany({ where: { shopId: shop.id } });
  await prisma.promptTemplate.deleteMany({ where: { shopId: shop.id } });
  await prisma.draft.deleteMany({ where: { shopId: shop.id } });
  await prisma.syncRun.deleteMany({ where: { shopId: shop.id } });
  await prisma.syncJob.deleteMany({ where: { shopId: shop.id } });
  await prisma.snapshot.deleteMany({ where: { shopId: shop.id } });
  await prisma.changeLog.deleteMany({ where: { shopId: shop.id } });
  if (fieldDefIds.length > 0) {
    await prisma.fieldValue.deleteMany({ where: { fieldDefinitionId: { in: fieldDefIds } } });
  }
  await prisma.fieldDefinition.deleteMany({ where: { shopId: shop.id } });
  await prisma.collection.deleteMany({ where: { shopId: shop.id } });
  await prisma.variant.deleteMany({ where: { product: { shopId: shop.id } } });
  await prisma.product.deleteMany({ where: { shopId: shop.id } });
  await prisma.shopMembership.deleteMany({ where: { shopId: shop.id } });
  await prisma.user.updateMany({ where: { shopId: shop.id }, data: { shopId: null } });
  await prisma.shopSubscription.deleteMany({ where: { shopId: shop.id } });
  await prisma.referralCommission.deleteMany({ where: { shopId: shop.id } });
  await prisma.shop.delete({ where: { id: shop.id } });

  return { ok: true, deleted: true };
});

app.get('/organizations/:id/shops/:shopId/members', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });

  const allowed = await ensureOrgAccess({ user, orgId: request.params.id, minRole: 'admin' });
  if (!allowed) return reply.code(403).send({ error: 'Org admin or owner role required' });

  const shop = await prisma.shop.findFirst({ where: { id: request.params.shopId, organizationId: request.params.id }, select: { id: true } });
  if (!shop) return reply.code(404).send({ error: 'Shop not found in this organization' });

  const members = await prisma.shopMembership.findMany({
    where: { shopId: shop.id },
    include: { user: { select: { id: true, email: true } } },
    orderBy: { createdAt: 'asc' },
  });

  return { members };
});

app.post('/organizations/:id/shops/:shopId/members', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const parsed = shopAccessGrantSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });

  const allowed = await ensureOrgAccess({ user, orgId: request.params.id, minRole: 'admin' });
  if (!allowed) return reply.code(403).send({ error: 'Org admin or owner role required' });

  const shop = await prisma.shop.findFirst({ where: { id: request.params.shopId, organizationId: request.params.id }, select: { id: true } });
  if (!shop) return reply.code(404).send({ error: 'Shop not found in this organization' });

  const target = await prisma.user.findUnique({ where: { id: parsed.data.userId }, select: { id: true } });
  if (!target) return reply.code(404).send({ error: 'User not found' });

  const membership = await prisma.shopMembership.upsert({
    where: { shopId_userId: { shopId: shop.id, userId: parsed.data.userId } },
    update: { role: 'member' },
    create: { shopId: shop.id, userId: parsed.data.userId, role: 'member' },
  });
  return reply.code(201).send({ membership });
});

app.delete('/organizations/:id/shops/:shopId/members/:userId', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });

  const allowed = await ensureOrgAccess({ user, orgId: request.params.id, minRole: 'admin' });
  if (!allowed) return reply.code(403).send({ error: 'Org admin or owner role required' });

  const shop = await prisma.shop.findFirst({ where: { id: request.params.shopId, organizationId: request.params.id }, select: { id: true } });
  if (!shop) return reply.code(404).send({ error: 'Shop not found in this organization' });

  await prisma.shopMembership.delete({
    where: { shopId_userId: { shopId: shop.id, userId: request.params.userId } },
  });
  return { ok: true };
});

// ══════════════════════════════════════════════════════════════════════════════
// SELF-SERVICE — Agency dashboard
// ══════════════════════════════════════════════════════════════════════════════

const getMyAgencyOrg = async (userId: string): Promise<string | null> => {
  const membership = await prisma.organizationMembership.findFirst({
    where: { userId, role: { in: ['owner', 'admin'] }, organization: { type: 'agency' } },
    select: { organizationId: true },
    orderBy: { createdAt: 'asc' },
  });
  return membership?.organizationId ?? null;
};

app.get('/agency/dashboard', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });

  const agencyOrgId = await getMyAgencyOrg(user.id);
  if (!agencyOrgId) return reply.code(403).send({ error: 'Ingen bureau-organisation tilknyttet din konto' });

  const [relations, pendingTotal, allTime] = await Promise.all([
    prisma.agencyClientRelation.findMany({
      where: { agencyOrgId, status: 'active' },
      include: { clientOrg: { select: { id: true, name: true, cvrNumber: true } } },
    }),
    prisma.referralCommission.aggregate({
      where: { agencyOrgId, status: 'pending' },
      _sum: { commissionMinor: true },
    }),
    prisma.referralCommission.aggregate({
      where: { agencyOrgId },
      _sum: { commissionMinor: true },
    }),
  ]);

  const referralCodes = relations.map((r) => ({ clientOrg: r.clientOrg, referralCode: r.referralCode, commissionRateBps: r.commissionRateBps }));

  return {
    agencyOrgId,
    activeClients: relations.length,
    pendingCommissionMinor: pendingTotal._sum.commissionMinor ?? 0,
    allTimeCommissionMinor: allTime._sum.commissionMinor ?? 0,
    referralCodes,
  };
});

app.get('/agency/commissions', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });

  const agencyOrgId = await getMyAgencyOrg(user.id);
  if (!agencyOrgId) return reply.code(403).send({ error: 'Ingen bureau-organisation tilknyttet din konto' });

  const page = Math.max(1, Number(request.query.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(request.query.pageSize ?? 20)));
  const statusFilter = request.query.status as string | undefined;

  const where: any = { agencyOrgId, ...(statusFilter && statusFilter !== 'all' ? { status: statusFilter } : {}) };

  const [total, commissions] = await Promise.all([
    prisma.referralCommission.count({ where }),
    prisma.referralCommission.findMany({
      where,
      include: { shop: { select: { id: true, shopUrl: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return { total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)), commissions };
});

app.post('/agency/payout-requests', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const parsed = payoutRequestCreateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });

  const agencyOrgId = await getMyAgencyOrg(user.id);
  if (!agencyOrgId) return reply.code(403).send({ error: 'Ingen bureau-organisation tilknyttet din konto' });
  if (parsed.data.agencyOrgId !== agencyOrgId) return reply.code(403).send({ error: 'Forbudt' });

  const periodFrom = new Date(parsed.data.periodFrom);
  const periodTo = new Date(parsed.data.periodTo);

  const pendingCommissions = await prisma.referralCommission.findMany({
    where: { agencyOrgId, status: 'pending', payoutRequestId: null },
    select: { id: true, commissionMinor: true },
  });

  if (pendingCommissions.length === 0) {
    return reply.code(422).send({ error: 'Ingen udestående provision at anmode om' });
  }

  const totalMinor = pendingCommissions.reduce((sum, c) => sum + c.commissionMinor, 0);

  const payout = await prisma.referralPayoutRequest.create({
    data: {
      agencyOrgId,
      requestedAmountMinor: totalMinor,
      periodFrom,
      periodTo,
    },
  });

  await prisma.referralCommission.updateMany({
    where: { id: { in: pendingCommissions.map((c) => c.id) } },
    data: { status: 'requested', payoutRequestId: payout.id },
  });

  return reply.code(201).send({ payout, commissionCount: pendingCommissions.length, totalMinor });
});

app.get('/agency/payout-requests', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });

  const agencyOrgId = await getMyAgencyOrg(user.id);
  if (!agencyOrgId) return reply.code(403).send({ error: 'Ingen bureau-organisation tilknyttet din konto' });

  const payouts = await prisma.referralPayoutRequest.findMany({
    where: { agencyOrgId },
    include: { commissions: { select: { id: true, billingMonth: true, commissionMinor: true, status: true, shopId: true } } },
    orderBy: { createdAt: 'desc' },
  });

  return { payouts };
});

app.post(
  '/webhooks/shopify',
  {
    config: {
      rawBody: true,
    },
  },
  async (request: any, reply: any) => {
    const raw = request.rawBody ?? '';
    const hmac = request.headers['x-shopify-hmac-sha256'] as string | undefined;
    const topic = (request.headers['x-shopify-topic'] as string | undefined) ?? 'unknown';
    const shopDomain = request.headers['x-shopify-shop-domain'] as string | undefined;
    const webhookId = request.headers['x-shopify-webhook-id'] as string | undefined;

    if (!verifyShopifyWebhook(raw, hmac, env.SHOPIFY_WEBHOOK_SECRET)) {
      request.log.warn(
        { topic, shopDomain, hmacPresent: Boolean(hmac), rawLength: raw.length },
        'Shopify webhook HMAC verification failed — check that SHOPIFY_WEBHOOK_SECRET matches the Shopify app\'s API secret key',
      );
      return reply.code(401).send({ error: 'Invalid webhook signature' });
    }

    if (!shopDomain) {
      return reply.code(400).send({ error: 'Missing shop domain' });
    }

    const shop = await prisma.shop.findUnique({ where: { shopUrl: `https://${shopDomain}` } });
    if (!shop) {
      return reply.code(404).send({ error: 'Shop not found' });
    }

    const idempotencyKey = webhookId ?? `${topic}:${shopDomain}:${createHash('sha256').update(raw).digest('hex')}`;
    const existing = await prisma.syncJob.findUnique({ where: { idempotencyKey } });
    if (existing) {
      return reply.code(202).send({ deduped: true });
    }

    const job = await prisma.syncJob.create({
      data: {
        shopId: shop.id,
        type: `webhook_${topic}`,
        status: 'queued',
        payloadJson: JSON.parse(raw || '{}'),
        idempotencyKey,
      },
    });

    await webhookQueue.add('shopify-webhook', { syncJobId: job.id }, { jobId: job.id });
    return reply.code(202).send({ accepted: true });
  },
);

// ══════════════════════════════════════════════════════════════════════════════
// INVITATIONS — Organization invitation system
// ══════════════════════════════════════════════════════════════════════════════

const escapeHtml = (str: string): string =>
  str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const sendEmail = async (to: string, subject: string, html: string): Promise<void> => {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: env.EMAIL_FROM, to, subject, html }),
  });
};

const buildInvitationEmail = (orgName: string, inviterName: string, acceptUrl: string): string => {
  return `<!DOCTYPE html>
<html lang="da">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Invitation til ${orgName}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#4f46e5,#6366f1);padding:32px 40px;">
              <div style="font-size:24px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">EL-PIM</div>
              <div style="font-size:13px;color:rgba(255,255,255,0.75);margin-top:4px;">Product Information Manager</div>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:40px 40px 32px;">
              <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#1e293b;line-height:1.3;">
                Du er inviteret til ${escapeHtml(orgName)}
              </h1>
              <p style="margin:0 0 24px;font-size:15px;color:#475569;line-height:1.6;">
                <strong style="color:#1e293b;">${escapeHtml(inviterName)}</strong> har inviteret dig til organisationen <strong style="color:#1e293b;">${escapeHtml(orgName)}</strong> på EL-PIM.
              </p>
              <p style="margin:0 0 32px;font-size:15px;color:#475569;line-height:1.6;">
                Klik på knappen herunder for at acceptere invitationen og få adgang til arbejdsområdet.
              </p>
              <!-- CTA Button -->
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-radius:10px;background:linear-gradient(135deg,#4f46e5,#6366f1);">
                    <a href="${acceptUrl}" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;letter-spacing:0.1px;">
                      Accepter invitation
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:24px 0 0;font-size:13px;color:#94a3b8;">
                Eller kopier dette link ind i din browser:<br />
                <span style="color:#6366f1;word-break:break-all;">${acceptUrl}</span>
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background:#f8fafc;padding:20px 40px;border-top:1px solid #e2e8f0;">
              <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.5;">
                Dette link udl&oslash;ber om 7 dage. Hvis du ikke forventer denne invitation, kan du se bort fra denne e-mail.<br />
                <strong>EL-PIM &middot; el-grossisten.dk</strong>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
};

const inviteBodySchema = z.object({
  email: z.string().email(),
  role: z.enum(['admin', 'member']).default('member'),
});

const transferOwnershipSchema = z.object({ userId: z.string() });

// POST /organizations/:id/invitations — invite a user
app.post('/organizations/:id/invitations', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });

  const allowed = await ensureOrgAccess({ user, orgId: request.params.id, minRole: 'admin' });
  if (!allowed) return reply.code(403).send({ error: 'Org admin or owner role required' });

  const parsed = inviteBodySchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());

  const org = await prisma.organization.findUnique({ where: { id: request.params.id }, select: { id: true, name: true } });
  if (!org) return reply.code(404).send({ error: 'Organization not found' });

  const { email, role } = parsed.data;

  // Check if a user already exists with that email
  const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existingUser) {
    // Add directly if not already a member
    const alreadyMember = await prisma.organizationMembership.findUnique({
      where: { organizationId_userId: { organizationId: org.id, userId: existingUser.id } },
      select: { id: true },
    });
    if (alreadyMember) {
      return reply.code(409).send({ error: 'Brugeren er allerede medlem af denne organisation' });
    }
    await prisma.organizationMembership.create({
      data: { organizationId: org.id, userId: existingUser.id, role },
    });
    const inviterName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;
    const appUrl = (request.headers.origin as string | undefined) ?? env.APP_BASE_URL ?? '';
    const html = buildInvitationEmail(org.name, inviterName, `${appUrl}/dashboard`);
    await sendEmail(email, `Du er blevet tilføjet til ${org.name} på EL-PIM`, html).catch((err) => {
      request.log.error(err, 'Failed to send direct-add notification email');
    });
    return reply.code(201).send({ added: true, email, role });
  }

  // Check for existing pending invitation
  const existingInvitation = await prisma.organizationInvitation.findFirst({
    where: {
      organizationId: org.id,
      invitedEmail: email,
      acceptedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: { id: true },
  });
  if (existingInvitation) {
    return reply.code(409).send({ error: 'Der er allerede en afventende invitation til denne e-mail' });
  }

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const invitation = await prisma.organizationInvitation.create({
    data: {
      organizationId: org.id,
      invitedEmail: email,
      invitedByUserId: user.id,
      role,
      expiresAt,
    },
    select: { id: true, invitedEmail: true, role: true, expiresAt: true, token: true },
  });

  const inviterName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;
  const appUrl = (request.headers.origin as string | undefined) ?? env.APP_BASE_URL ?? '';
  const acceptUrl = `${appUrl}/invitations/${invitation.token}/accept`;
  await sendEmail(email, `Du er inviteret til ${org.name} på EL-PIM`, buildInvitationEmail(org.name, inviterName, acceptUrl)).catch((err) => {
    request.log.error(err, 'Failed to send invitation email');
  });

  return reply.code(201).send({
    invitation: { id: invitation.id, email: invitation.invitedEmail, role: invitation.role, expiresAt: invitation.expiresAt },
  });
});

// GET /organizations/:id/invitations — list pending invitations
app.get('/organizations/:id/invitations', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });

  const allowed = await ensureOrgAccess({ user, orgId: request.params.id, minRole: 'admin' });
  if (!allowed) return reply.code(403).send({ error: 'Org admin or owner role required' });

  const org = await prisma.organization.findUnique({ where: { id: request.params.id }, select: { id: true } });
  if (!org) return reply.code(404).send({ error: 'Organization not found' });

  const invitations = await prisma.organizationInvitation.findMany({
    where: {
      organizationId: org.id,
      acceptedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: { id: true, invitedEmail: true, role: true, expiresAt: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });

  return { invitations };
});

// DELETE /organizations/:id/invitations/:invitationId — cancel invitation
app.delete('/organizations/:id/invitations/:invitationId', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid. Please log in again.' });

  const allowed = await ensureOrgAccess({ user, orgId: request.params.id, minRole: 'admin' });
  if (!allowed) return reply.code(403).send({ error: 'Org admin or owner role required' });

  const invitation = await prisma.organizationInvitation.findFirst({
    where: { id: request.params.invitationId, organizationId: request.params.id },
    select: { id: true },
  });
  if (!invitation) return reply.code(404).send({ error: 'Invitation not found' });

  await prisma.organizationInvitation.delete({ where: { id: invitation.id } });
  return { ok: true };
});

// GET /organizations/:id/members — list current members
app.get('/organizations/:id/members', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid.' });

  const allowed = await ensureOrgAccess({ user, orgId: request.params.id });
  if (!allowed) return reply.code(403).send({ error: 'Org membership required' });

  const memberships = await prisma.organizationMembership.findMany({
    where: { organizationId: request.params.id },
    include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
    orderBy: { createdAt: 'asc' },
  });

  return reply.send({
    members: memberships.map((m) => ({
      userId: m.userId,
      email: m.user.email,
      firstName: m.user.firstName,
      lastName: m.user.lastName,
      role: m.role,
      joinedAt: m.createdAt,
    })),
  });
});

// POST /organizations/:id/transfer-ownership — transfer org ownership to another member
app.post('/organizations/:id/transfer-ownership', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user) return reply.code(401).send({ error: 'Session invalid.' });

  const allowed = await ensureOrgAccess({ user, orgId: request.params.id, minRole: 'owner' });
  if (!allowed) return reply.code(403).send({ error: 'Only the owner can transfer ownership' });

  const parsed = transferOwnershipSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send(parsed.error.flatten());

  const { userId } = parsed.data;
  if (userId === user.id) return reply.code(400).send({ error: 'Du kan ikke overdrage ejerskab til dig selv' });

  const targetMembership = await prisma.organizationMembership.findFirst({
    where: { organizationId: request.params.id, userId },
    select: { id: true },
  });
  if (!targetMembership) return reply.code(404).send({ error: 'Brugeren er ikke medlem af organisationen' });

  await prisma.$transaction([
    prisma.organizationMembership.updateMany({
      where: { organizationId: request.params.id, userId },
      data: { role: 'owner' },
    }),
    prisma.organizationMembership.updateMany({
      where: { organizationId: request.params.id, userId: user.id },
      data: { role: 'admin' },
    }),
  ]);

  return reply.send({ ok: true });
});

// POST /invitations/:token/accept — accept an invitation (no auth required)
app.post('/invitations/:token/accept', async (request: any, reply: any) => {
  const invitation = await prisma.organizationInvitation.findUnique({
    where: { token: request.params.token },
    include: { organization: { select: { id: true, name: true } } },
  });

  if (!invitation) return reply.code(404).send({ error: 'Invitation ikke fundet' });
  if (invitation.acceptedAt) return reply.code(409).send({ error: 'Invitation er allerede accepteret' });
  if (invitation.expiresAt < new Date()) return reply.code(410).send({ error: 'Invitation er udløbet' });

  const body = (request.body ?? {}) as Record<string, unknown>;

  // Attempt to find user with the invited email
  let targetUser = await prisma.user.findUnique({ where: { email: invitation.invitedEmail }, select: { id: true, email: true } });

  const baseUrl = (request.headers.origin as string | undefined) ?? env.APP_BASE_URL ?? '';

  // If no user and registration data (firstName + lastName) provided, create the user
  if (!targetUser && body.firstName && body.lastName) {
    targetUser = await prisma.user.create({
      data: {
        email: invitation.invitedEmail,
        firstName: String(body.firstName).trim(),
        lastName: String(body.lastName).trim(),
        role: 'member',
      },
      select: { id: true, email: true },
    });
  }

  if (!targetUser) {
    // No user yet — tell frontend to show registration form
    return reply.code(200).send({
      requiresRegistration: true,
      email: invitation.invitedEmail,
      organizationName: invitation.organization.name,
    });
  }

  // Check if already a member
  const alreadyMember = await prisma.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId: invitation.organizationId, userId: targetUser.id } },
    select: { id: true },
  });

  if (!alreadyMember) {
    await prisma.organizationMembership.create({
      data: { organizationId: invitation.organizationId, userId: targetUser.id, role: invitation.role },
    });
  }

  await prisma.organizationInvitation.update({
    where: { id: invitation.id },
    data: { acceptedAt: new Date() },
  });

  // Send magic link so the user can log in immediately
  try {
    await sendMagicLink({ userId: targetUser.id, email: targetUser.email, redirectTo: '/dashboard/products', baseUrl });
    return reply.code(200).send({ magicLinkSent: true, organizationName: invitation.organization.name });
  } catch {
    // If email fails, fall back to "success" so they can request login manually
    return reply.code(200).send({ ok: true, organizationName: invitation.organization.name });
  }
});

// Apply any schema additions that may not have run via prisma migrate yet.
// Uses IF NOT EXISTS / conditional DDL so it's fully idempotent.
const applyBootstrapMigrations = async (): Promise<void> => {
  const statements = [
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "phone" TEXT`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "referralSource" TEXT`,
    `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3)`,
    // Make passwordHash nullable if it isn't already (safe no-op if already nullable)
    `DO $$ BEGIN
       IF EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'User' AND column_name = 'passwordHash' AND is_nullable = 'NO'
       ) THEN
         ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;
       END IF;
     END $$`,
    `CREATE TABLE IF NOT EXISTS "MagicLinkToken" (
       "id"         TEXT        NOT NULL,
       "userId"     TEXT        NOT NULL,
       "token"      TEXT        NOT NULL,
       "expiresAt"  TIMESTAMP(3) NOT NULL,
       "usedAt"     TIMESTAMP(3),
       "redirectTo" TEXT,
       "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT "MagicLinkToken_pkey" PRIMARY KEY ("id")
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "MagicLinkToken_token_key" ON "MagicLinkToken"("token")`,
    `DO $$ BEGIN
       IF NOT EXISTS (
         SELECT 1 FROM information_schema.table_constraints
         WHERE constraint_name = 'MagicLinkToken_userId_fkey'
       ) THEN
         ALTER TABLE "MagicLinkToken" ADD CONSTRAINT "MagicLinkToken_userId_fkey"
           FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
       END IF;
     END $$`,
  ];

  for (const sql of statements) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (err) {
      app.log.warn({ err }, 'bootstrap migration warning (non-fatal)');
    }
  }
  app.log.info('Bootstrap migrations complete');
};

// ══════════════════════════════════════════════════════════════════════════════
// QUALITY RULES
// ══════════════════════════════════════════════════════════════════════════════

app.get('/quality-rules', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  const shopId = resolveActiveShopId(request, user ?? {}) ?? '';
  const rules = await prisma.qualityRule.findMany({ where: { shopId }, orderBy: { createdAt: 'asc' } });
  return { rules };
});

app.post('/quality-rules', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  const shopId = resolveActiveShopId(request, user ?? {}) ?? '';
  const { name, field, operator, value, severity } = request.body as {
    name: string; field: string; operator: string; value?: string; severity?: string;
  };
  if (!name || !field || !operator) return reply.code(400).send({ error: 'name, field og operator er påkrævet' });
  const rule = await prisma.qualityRule.create({
    data: { shopId, name, field, operator, value: value ?? null, severity: severity ?? 'warning' },
  });
  return { rule };
});

app.patch('/quality-rules/:id', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  const shopId = resolveActiveShopId(request, user ?? {}) ?? '';
  const existing = await prisma.qualityRule.findFirst({ where: { id: request.params.id, shopId } });
  if (!existing) return reply.code(404).send({ error: 'Regel ikke fundet' });
  const { name, field, operator, value, severity, active } = request.body as Partial<{
    name: string; field: string; operator: string; value: string | null; severity: string; active: boolean;
  }>;
  const rule = await prisma.qualityRule.update({
    where: { id: existing.id },
    data: { ...(name !== undefined ? { name } : {}), ...(field !== undefined ? { field } : {}), ...(operator !== undefined ? { operator } : {}), ...(value !== undefined ? { value } : {}), ...(severity !== undefined ? { severity } : {}), ...(active !== undefined ? { active } : {}) },
  });
  return { rule };
});

app.delete('/quality-rules/:id', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  const shopId = resolveActiveShopId(request, user ?? {}) ?? '';
  const existing = await prisma.qualityRule.findFirst({ where: { id: request.params.id, shopId } });
  if (!existing) return reply.code(404).send({ error: 'Regel ikke fundet' });
  await prisma.qualityRule.delete({ where: { id: existing.id } });
  return { ok: true };
});

// ══════════════════════════════════════════════════════════════════════════════
// BULK ALT-TEXT
// ══════════════════════════════════════════════════════════════════════════════

app.post('/ai/alt-text/bulk', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  const shopId = resolveActiveShopId(request, user ?? {}) ?? '';
  const { productIds, notifyEmail } = request.body as { productIds: string[]; notifyEmail?: string };
  if (!productIds?.length) return reply.code(400).send({ error: 'productIds er påkrævet' });

  const syncJob = await prisma.syncJob.create({
    data: {
      shopId,
      type: 'ai_alt_text',
      status: 'queued',
      payloadJson: { productIds, notifyEmail: notifyEmail ?? null, altTextProcessed: 0, altTextTotal: productIds.length } as any,
    },
  });
  await altTextQueue.add('alt-text', { syncJobId: syncJob.id }, { jobId: syncJob.id });
  return { jobId: syncJob.id };
});

app.post('/ai/alt-text/jobs/:id/cancel', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  const shopId = resolveActiveShopId(request, user ?? {}) ?? '';
  const syncJob = await prisma.syncJob.findFirst({ where: { id: request.params.id, shopId } });
  if (!syncJob) return reply.code(404).send({ error: 'Job ikke fundet' });
  await prisma.syncJob.update({ where: { id: syncJob.id }, data: { payloadJson: { ...(syncJob.payloadJson as object), cancelRequested: true } } });
  return { ok: true };
});

// ══════════════════════════════════════════════════════════════════════════════
// PRODUCT METAFIELDS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/products/:id/metafields', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  const shopId = resolveActiveShopId(request, user ?? {}) ?? '';
  const product = await prisma.product.findFirst({ where: { id: request.params.id, shopId } });
  if (!product) return reply.code(404).send({ error: 'Produkt ikke fundet' });
  const metafields = await prisma.productMetafield.findMany({ where: { productId: product.id } });
  return { metafields };
});

app.patch('/products/:id/metafields', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  const shopId = resolveActiveShopId(request, user ?? {}) ?? '';
  const product = await prisma.product.findFirst({ where: { id: request.params.id, shopId } });
  if (!product) return reply.code(404).send({ error: 'Produkt ikke fundet' });
  const { metafields } = request.body as { metafields: Array<{ namespace: string; key: string; value: string; type?: string }> };
  if (!Array.isArray(metafields)) return reply.code(400).send({ error: 'metafields array påkrævet' });
  await Promise.all(metafields.map((mf) =>
    prisma.productMetafield.upsert({
      where: { productId_namespace_key: { productId: product.id, namespace: mf.namespace, key: mf.key } },
      update: { value: mf.value, type: mf.type ?? 'single_line_text_field' },
      create: { shopId, productId: product.id, namespace: mf.namespace, key: mf.key, value: mf.value, type: mf.type ?? 'single_line_text_field' },
    }),
  ));
  await prisma.product.update({ where: { id: product.id }, data: { updatedAt: new Date() } });
  return { ok: true };
});

// Sync metafield definitions from Shopify + fetch metafields for all products
app.post('/shops/sync-metafields', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  if (!user?.shopId) return reply.code(400).send({ error: 'Tilslut en shop først' });
  const shop = await prisma.shop.findUnique({ where: { id: user.shopId } });
  if (!shop) return reply.code(404).send({ error: 'Shop ikke fundet' });
  const adminToken = decryptSecret(shop.encryptedAdminToken, env.MASTER_ENCRYPTION_KEY);
  const client = new ShopifyGraphQLClient({ storeUrl: shop.shopUrl, adminToken });

  // Fetch metafield definitions for products
  const defQuery = `query MetafieldDefs($cursor: String) {
    metafieldDefinitions(first: 50, ownerType: PRODUCT, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id namespace key name type { name } }
    }
  }`;

  let cursor: string | null = null;
  let synced = 0;
  const definitions: Array<{ namespace: string; key: string; name: string; type: string }> = [];

  do {
    const rawResult: unknown = await client.execute(defQuery, { cursor }).catch(() => null);
    if (!rawResult) break;
    const page = (rawResult as any)?.metafieldDefinitions;
    if (!page?.nodes) break;
    for (const def of page.nodes) {
      definitions.push({ namespace: def.namespace, key: def.key, name: def.name, type: def.type?.name ?? 'single_line_text_field' });
    }
    cursor = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);

  // For each product, fetch its metafields (sampling 200 products)
  const products = await prisma.product.findMany({
    where: { shopId: user.shopId, shopifyProductGid: { not: null }, shopifyDeletedAt: null },
    select: { id: true, shopifyProductGid: true },
    take: 200,
  });

  if (products.length > 0) {
    const productMetaQuery = `query ProductMetafields($id: ID!) {
      product(id: $id) {
        metafields(first: 50) {
          nodes { namespace key value type }
        }
      }
    }`;

    for (const product of products) {
      const result = await client.execute(productMetaQuery, { id: product.shopifyProductGid }).catch(() => null);
      const mfNodes = (result as any)?.product?.metafields?.nodes ?? [];
      for (const mf of mfNodes) {
        if (!mf.namespace || !mf.key) continue;
        await prisma.productMetafield.upsert({
          where: { productId_namespace_key: { productId: product.id, namespace: mf.namespace, key: mf.key } },
          update: { value: mf.value ?? '', type: mf.type ?? 'single_line_text_field' },
          create: { shopId: user.shopId, productId: product.id, namespace: mf.namespace, key: mf.key, value: mf.value ?? '', type: mf.type ?? 'single_line_text_field' },
        });
        synced++;
      }
    }
  }

  return { ok: true, definitionCount: definitions.length, metafieldsSynced: synced };
});

// ══════════════════════════════════════════════════════════════════════════════
// GOOGLE SHOPPING FEED
// ══════════════════════════════════════════════════════════════════════════════

const stripHtml = (html: string): string =>
  html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(+n)).trim();

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

app.get('/feeds/google', async (request: any, reply: any) => {
  // Public endpoint — authenticate by shopId query param + optional token
  const shopId = request.query.shopId as string | undefined;
  if (!shopId) return reply.code(400).send({ error: 'shopId query param påkrævet' });

  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) return reply.code(404).send({ error: 'Shop ikke fundet' });

  const currency = 'DKK'; // TODO: make configurable via ShopSetting
  const baseUrl = (request.query.baseUrl as string | undefined) ?? shop.shopUrl;

  const products = await prisma.product.findMany({
    where: { shopId, shopifyDeletedAt: null, status: 'ACTIVE' },
    include: { variants: { take: 1 }, metafields: { where: { namespace: 'google' } } },
    take: 5000,
  });

  const items = products.map((p) => {
    const v = p.variants[0];
    const img = (p.imagesJson as Array<{ url: string; altText?: string }>)[0];
    const gtin = v?.barcode || p.metafields.find((m) => m.key === 'gtin')?.value;
    const mpn = v?.sku;
    const price = v?.price ? `${v.price} ${currency}` : null;
    const desc = stripHtml(p.descriptionHtml ?? p.title);
    return `    <item>
      <g:id>${escapeXml(p.shopifyProductGid ?? p.id)}</g:id>
      <g:title>${escapeXml(p.title)}</g:title>
      <g:description>${escapeXml(desc.slice(0, 5000))}</g:description>
      <g:link>${escapeXml(`${baseUrl}/products/${p.handle}`)}</g:link>
      ${img ? `<g:image_link>${escapeXml(img.url)}</g:image_link>` : ''}
      ${price ? `<g:price>${escapeXml(price)}</g:price>` : ''}
      <g:availability>${(v?.inventoryQuantity ?? 0) > 0 ? 'in stock' : 'out of stock'}</g:availability>
      <g:condition>new</g:condition>
      ${p.vendor ? `<g:brand>${escapeXml(p.vendor)}</g:brand>` : ''}
      ${gtin ? `<g:gtin>${escapeXml(gtin)}</g:gtin>` : ''}
      ${mpn ? `<g:mpn>${escapeXml(mpn)}</g:mpn>` : ''}
    </item>`;
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>${escapeXml(shop.displayName ?? shop.shopUrl)}</title>
    <link>${escapeXml(shop.shopUrl)}</link>
    <description>Google Shopping Feed — ${escapeXml(shop.displayName ?? shop.shopUrl)}</description>
${items}
  </channel>
</rss>`;

  reply.header('Content-Type', 'application/rss+xml; charset=utf-8');
  return reply.send(xml);
});

app.post('/notify/bulk-done', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const { email, type, count } = request.body as { email?: string; type?: string; count?: number };
  if (!email || !env.RESEND_API_KEY || !env.EMAIL_FROM) {
    return reply.code(204).send();
  }
  const label = type === 'tolddata' ? 'Bulk tolddata' : 'Bulk AI-generering';
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: email,
      subject: `${label} afsluttet`,
      html: `<p><strong>${label}</strong> er færdig.</p><p>${count ?? 0} poster behandlet i EL-PIM.</p>`,
    }),
  });
  return reply.code(204).send();
});

// ══════════════════════════════════════════════════════════════════════════════
// RUN CAMPAIGNS — bulk AI processing
// ══════════════════════════════════════════════════════════════════════════════

// GET /run-campaigns — list all campaigns for current shop
app.get('/run-campaigns', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  const shopId = await resolveShopIdForPlatformAdmin(request, user);
  if (!shopId) return reply.code(400).send({ error: 'Connect a shop first' });

  const campaigns = await prisma.runCampaign.findMany({
    where: { shopId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, name: true, status: true, fieldsJson: true,
      batchSize: true, collectionsFirst: true,
      excludeSkusJson: true, overwriteJson: true,
      totalItems: true, doneItems: true, failedItems: true, skippedItems: true,
      startedAt: true, completedAt: true, createdAt: true, updatedAt: true,
    },
  });
  return { campaigns };
});

// POST /run-campaigns — create new campaign
app.post('/run-campaigns', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  const shopId = await resolveShopIdForPlatformAdmin(request, user);
  if (!shopId) return reply.code(400).send({ error: 'Connect a shop first' });

  const body = (request.body ?? {}) as {
    name?: string;
    fieldsJson?: string[];
    batchSize?: number;
    collectionsFirst?: boolean;
    excludeSkusJson?: string[];
    overwriteJson?: string[];
    sourceIdsJson?: string[];
    sourcesOnly?: boolean;
    promptsJson?: Record<string, string>;
    autoSync?: boolean;
    outputLength?: string;
  };

  if (!body.name?.trim()) return reply.code(400).send({ error: 'name er påkrævet' });
  if (!Array.isArray(body.fieldsJson) || body.fieldsJson.length === 0) return reply.code(400).send({ error: 'Vælg mindst ét felt' });

  const campaign = await prisma.runCampaign.create({
    data: {
      shopId,
      name: body.name.trim(),
      fieldsJson: body.fieldsJson,
      batchSize: body.batchSize ?? 1,
      collectionsFirst: body.collectionsFirst ?? true,
      excludeSkusJson: body.excludeSkusJson ?? [],
      overwriteJson: body.overwriteJson ?? [],
      sourceIdsJson: body.sourceIdsJson ?? [],
      sourcesOnly: body.sourcesOnly ?? false,
      promptsJson: body.promptsJson ?? {},
      autoSync: body.autoSync ?? false,
      outputLength: body.outputLength ?? 'mellem',
    } as any,
  });
  return reply.code(201).send({ campaign });
});

// GET /run-campaigns/:id — get campaign with recent logs and item stats
app.get('/run-campaigns/:id', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  const shopId = await resolveShopIdForPlatformAdmin(request, user);
  if (!shopId) return reply.code(400).send({ error: 'Connect a shop first' });

  const { id } = request.params as { id: string };
  const campaign = await prisma.runCampaign.findFirst({
    where: { id, shopId },
  });
  if (!campaign) return reply.code(404).send({ error: 'Kampagne ikke fundet' });

  const [logs, itemCounts] = await Promise.all([
    prisma.runCampaignLog.findMany({
      where: { campaignId: id },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    prisma.runCampaignItem.groupBy({
      by: ['status'],
      where: { campaignId: id },
      _count: { status: true },
    }),
  ]);

  return { campaign, logs, itemCounts };
});

// GET /run-campaigns/:id/items — paginated item list
app.get('/run-campaigns/:id/items', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  const shopId = await resolveShopIdForPlatformAdmin(request, user);
  if (!shopId) return reply.code(400).send({ error: 'Connect a shop first' });

  const { id } = request.params as { id: string };
  const campaign = await prisma.runCampaign.findFirst({ where: { id, shopId }, select: { id: true } });
  if (!campaign) return reply.code(404).send({ error: 'Kampagne ikke fundet' });

  const q = request.query as { status?: string; page?: string; pageSize?: string };
  const page = Math.max(1, Number(q.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Number(q.pageSize ?? 100)));
  const statusFilter = q.status && q.status !== 'all' ? q.status : undefined;

  const where: any = { campaignId: id, ...(statusFilter ? { status: statusFilter } : {}) };
  const [total, items] = await Promise.all([
    prisma.runCampaignItem.count({ where }),
    prisma.runCampaignItem.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true, productId: true, title: true, sku: true, ean: true, status: true,
        fieldsDoneJson: true, fieldValuesJson: true, syncedAt: true, processedAt: true, errorMsg: true, sortOrder: true,
      },
    }),
  ]);
  return { total, page, pageSize, items };
});

// POST /run-campaigns/:id/populate — fill campaign with products (collections-first ordering)
app.post('/run-campaigns/:id/populate', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  const shopId = await resolveShopIdForPlatformAdmin(request, user);
  if (!shopId) return reply.code(400).send({ error: 'Connect a shop first' });

  const { id } = request.params as { id: string };
  const campaign = await prisma.runCampaign.findFirst({ where: { id, shopId } });
  if (!campaign) return reply.code(404).send({ error: 'Kampagne ikke fundet' });
  if (campaign.status !== 'draft') return reply.code(400).send({ error: 'Kan kun populere en draft-kampagne' });

  const body = (request.body ?? {}) as { limit?: number };
  const limit = body.limit ?? 0; // 0 = all

  const excludeSkus = (campaign.excludeSkusJson as string[]) ?? [];

  // Fetch all products with their first collection — used for round-robin interleaving
  const productFilter = {
    shopId,
    shopifyDeletedAt: null,
    ...(excludeSkus.length > 0 ? {
      NOT: { variants: { some: { sku: { in: excludeSkus } } } },
    } : {}),
  };

  const allFetched = await prisma.product.findMany({
    where: productFilter,
    orderBy: [{ handle: 'asc' }],
    select: {
      id: true, title: true,
      variants: { take: 1, select: { sku: true, barcode: true } },
      collections: { take: 1, select: { collectionId: true } },
    },
  });

  // Round-robin interleave by collection so a small test batch covers many categories.
  // Products with no collection go at the end.
  const byCollection = new Map<string, typeof allFetched>();
  const noCollection: typeof allFetched = [];
  for (const p of allFetched) {
    const colId = p.collections[0]?.collectionId ?? null;
    if (!colId) { noCollection.push(p); continue; }
    if (!byCollection.has(colId)) byCollection.set(colId, []);
    byCollection.get(colId)!.push(p);
  }
  const buckets = Array.from(byCollection.values());
  const interleaved: typeof allFetched = [];
  let round = 0;
  while (interleaved.length < allFetched.length - noCollection.length) {
    for (const bucket of buckets) {
      if (round < bucket.length) interleaved.push(bucket[round]!);
    }
    round++;
  }
  const allProducts = campaign.collectionsFirst
    ? [...interleaved, ...noCollection]
    : allFetched;

  const limited = limit > 0 ? allProducts.slice(0, limit) : allProducts;

  // Upsert items with sortOrder reflecting the interleaved collection order
  const upserts = limited.map((p, i) =>
    prisma.runCampaignItem.upsert({
      where: { campaignId_productId: { campaignId: id, productId: p.id } },
      update: { sortOrder: i },
      create: {
        campaignId: id,
        productId: p.id,
        title: p.title,
        sku: p.variants?.[0]?.sku ?? null,
        ean: p.variants?.[0]?.barcode ?? null,
        sortOrder: i,
      },
    }),
  );

  await prisma.$transaction(upserts);

  const total = await prisma.runCampaignItem.count({ where: { campaignId: id } });
  await prisma.runCampaign.update({ where: { id }, data: { totalItems: total } });

  await prisma.runCampaignLog.create({
    data: {
      campaignId: id, level: 'info',
      message: `Kampagne populeret med ${total} produkter fordelt på ${byCollection.size} kollektioner (round-robin rækkefølge) + ${noCollection.length} uden kollektion.`,
    },
  });

  return { total, withCollections: interleaved.length, withoutCollections: noCollection.length };
});

// POST /run-campaigns/:id/start — start or resume processing
app.post('/run-campaigns/:id/start', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  const shopId = await resolveShopIdForPlatformAdmin(request, user);
  if (!shopId) return reply.code(400).send({ error: 'Connect a shop first' });

  const { id } = request.params as { id: string };
  const campaign = await prisma.runCampaign.findFirst({ where: { id, shopId } });
  if (!campaign) return reply.code(404).send({ error: 'Kampagne ikke fundet' });
  if (campaign.status === 'running') return reply.code(400).send({ error: 'Kampagne kører allerede' });
  if (campaign.status === 'done') return reply.code(400).send({ error: 'Kampagne er allerede færdig' });

  const pendingCount = await prisma.runCampaignItem.count({ where: { campaignId: id, status: { in: ['pending', 'failed'] } } });
  if (pendingCount === 0) return reply.code(400).send({ error: 'Ingen ventende produkter' });

  await prisma.runCampaign.update({
    where: { id },
    data: { status: 'running', startedAt: campaign.startedAt ?? new Date() },
  });

  // Enqueue the campaign processing job
  const syncJob = await prisma.syncJob.create({
    data: {
      shopId,
      type: 'run_campaign',
      status: 'queued',
      payloadJson: { campaignId: id },
    },
  });

  // Import runCampaignQueue lazily to avoid circular deps — enqueue via HTTP signal instead
  await prisma.runCampaignLog.create({
    data: { campaignId: id, level: 'info', message: `Kørsel startet. Behandler ${pendingCount} ventende produkter.` },
  });

  return { ok: true, syncJobId: syncJob.id, pendingCount };
});

// POST /run-campaigns/:id/pause — pause running campaign
app.post('/run-campaigns/:id/pause', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  const shopId = await resolveShopIdForPlatformAdmin(request, user);
  if (!shopId) return reply.code(400).send({ error: 'Connect a shop first' });

  const { id } = request.params as { id: string };
  const campaign = await prisma.runCampaign.findFirst({ where: { id, shopId } });
  if (!campaign) return reply.code(404).send({ error: 'Kampagne ikke fundet' });
  if (campaign.status !== 'running') return reply.code(400).send({ error: 'Kampagne kører ikke' });

  await prisma.runCampaign.update({ where: { id }, data: { status: 'paused' } });
  await prisma.runCampaignLog.create({
    data: { campaignId: id, level: 'warn', message: 'Kørsel sat på pause. Igangværende batch færdiggøres.' },
  });
  return { ok: true };
});

// PATCH /run-campaigns/:id/items/:itemId — skip or reset a single item
app.patch('/run-campaigns/:id/items/:itemId', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  const shopId = await resolveShopIdForPlatformAdmin(request, user);
  if (!shopId) return reply.code(400).send({ error: 'Connect a shop first' });

  const { id, itemId } = request.params as { id: string; itemId: string };
  const campaign = await prisma.runCampaign.findFirst({ where: { id, shopId }, select: { id: true } });
  if (!campaign) return reply.code(404).send({ error: 'Kampagne ikke fundet' });

  const body = (request.body ?? {}) as { status?: string };
  if (!['skipped', 'pending'].includes(body.status ?? '')) return reply.code(400).send({ error: 'status skal være skipped eller pending' });

  await prisma.runCampaignItem.update({
    where: { id: itemId },
    data: { status: body.status, ...(body.status === 'pending' ? { errorMsg: null, processedAt: null, fieldsDoneJson: {} } : {}) },
  });
  return { ok: true };
});

// POST /run-campaigns/:id/sync — enqueue outbound sync for all done items
app.post('/run-campaigns/:id/sync', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  const shopId = await resolveShopIdForPlatformAdmin(request, user);
  if (!shopId) return reply.code(400).send({ error: 'Connect a shop first' });

  const { id } = request.params as { id: string };
  const campaign = await prisma.runCampaign.findFirst({ where: { id, shopId } });
  if (!campaign) return reply.code(404).send({ error: 'Kampagne ikke fundet' });

  const doneItems = await prisma.runCampaignItem.findMany({
    where: { campaignId: id, status: 'done' },
    select: { id: true, productId: true },
    orderBy: { sortOrder: 'asc' },
  });
  if (doneItems.length === 0) return reply.code(400).send({ error: 'Ingen færdige produkter at synkronisere' });

  // Build system-field patch per product if campaign includes system fields
  const systemFieldIds = (campaign.fieldsJson as string[]).filter((f) => f.startsWith('__'));
  const productDataMap = new Map<string, { descriptionHtml: string | null; seoJson: unknown; title: string }>();
  if (systemFieldIds.length > 0) {
    const products = await prisma.product.findMany({
      where: { id: { in: doneItems.map((i) => i.productId) } },
      select: { id: true, descriptionHtml: true, seoJson: true, title: true },
    });
    for (const p of products) productDataMap.set(p.id, p);
  }

  const buildPatch = (productId: string): Record<string, unknown> => {
    if (systemFieldIds.length === 0) return {};
    const p = productDataMap.get(productId);
    if (!p) return {};
    const patch: Record<string, unknown> = {};
    if (systemFieldIds.includes('__description') && p.descriptionHtml != null) patch.descriptionHtml = p.descriptionHtml;
    if ((systemFieldIds.includes('__seo_title') || systemFieldIds.includes('__seo_description')) && p.seoJson) patch.seoJson = p.seoJson;
    if (systemFieldIds.includes('__title')) patch.title = p.title;
    return patch;
  };

  // Enqueue sync jobs with staggered delays (200 ms apart ≈ 5 jobs/s, well within Shopify's ~50 pts/s budget)
  // Process in chunks to avoid holding a massive transaction
  const CHUNK = 500;
  let queued = 0;
  for (let offset = 0; offset < doneItems.length; offset += CHUNK) {
    const chunk = doneItems.slice(offset, offset + CHUNK);
    const jobs = await Promise.all(
      chunk.map((item) =>
        prisma.syncJob.create({
          data: { shopId, type: 'outbound_product_patch', payloadJson: { productId: item.productId, patch: buildPatch(item.productId) } as any },
        }),
      ),
    );
    await syncQueue.addBulk(
      jobs.map((job, i) => ({
        name: 'outbound-product',
        data: { syncJobId: job.id },
        opts: { jobId: job.id, delay: (offset + i) * 200 },
      })),
    );
    queued += chunk.length;
  }

  // Stamp syncedAt on all done items
  await prisma.runCampaignItem.updateMany({
    where: { campaignId: id, status: 'done' },
    data: { syncedAt: new Date() },
  });

  return { ok: true, queued };
});

// DELETE /run-campaigns/:id — delete campaign and all items/logs
app.delete('/run-campaigns/:id', async (request: any, reply: any) => {
  if (!(await withAuth(request, reply))) return;
  const user = await getCurrentUser(request);
  const shopId = await resolveShopIdForPlatformAdmin(request, user);
  if (!shopId) return reply.code(400).send({ error: 'Connect a shop first' });

  const { id } = request.params as { id: string };
  const campaign = await prisma.runCampaign.findFirst({ where: { id, shopId }, select: { id: true, status: true } });
  if (!campaign) return reply.code(404).send({ error: 'Kampagne ikke fundet' });
  if (campaign.status === 'running') return reply.code(400).send({ error: 'Stop kampagnen først' });

  await prisma.runCampaign.delete({ where: { id } });
  return { ok: true };
});

const start = async (): Promise<void> => {
  await applyBootstrapMigrations();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
};

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'Graceful shutdown initiated');
  await app.close();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
