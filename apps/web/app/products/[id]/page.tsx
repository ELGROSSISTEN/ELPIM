'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { API_URL, apiFetch, getActiveShopId, getToken } from '../../../lib/api';
import { registerBackgroundActivityJobs } from '../../../lib/background-activity';
import { toast } from '../../../components/toaster';

type Product = {
  id: string;
  title: string;
  handle: string;
  vendor?: string;
  tagsJson?: string[];
  status?: string;
  productType?: string;
  descriptionHtml?: string;
  publishedAt?: string | null;
  updatedAt?: string;
  lastShopifySyncAt?: string | null;
  seoJson?: { title?: string; description?: string } | null;
  shopifyUpdatedAt?: string | null;
  shopifyProductGid?: string | null;
  imagesJson?: Array<{ url: string; altText?: string }>;
  shop?: { shopUrl?: string };
  variants?: Array<{
    id: string;
    sku?: string;
    barcode?: string;
    price?: string;
    compareAtPrice?: string;
    optionValuesJson?: string[];
    weight?: number | null;
    weightUnit?: string | null;
    requiresShipping?: boolean | null;
    taxable?: boolean | null;
    inventoryPolicy?: string | null;
    inventoryQuantity?: number | null;
    hsCode?: string | null;
    countryOfOrigin?: string | null;
  }>;
  fieldValues?: Array<{
    id: string;
    fieldDefinitionId: string;
    valueJson: unknown;
    fieldDefinition: {
      id: string;
      key: string;
      label: string;
    };
  }>;
};

type FieldDefinition = {
  id: string;
  key: string;
  label: string;
  scope: 'product' | 'variant' | 'collection';
  type: 'text' | 'number' | 'boolean' | 'json' | 'date' | 'html';
  isBuiltIn?: boolean;
  lockLevel?: 'none' | 'users' | 'all';
};

type HistoryLog = {
  id: string;
  source: string;
  fieldKey?: string | null;
  beforeJson?: unknown;
  afterJson?: unknown;
  createdAt: string;
  user?: { email: string; firstName?: string | null; lastName?: string | null } | null;
};

type HistorySnapshot = {
  id: string;
  reason: string;
  blobJson: unknown;
  createdAt: string;
};

type KeywordSuggestion = {
  keyword: string;
  intent: string;
  trafficPotential: string;
  reason: string;
};

type AiUsageSummary = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostDkk: number;
  estimatedCostUsd: number;
};

type AiUsageLog = {
  id: string;
  feature: string;
  estimatedCostDkk: number;
  model: string;
  createdAt: string;
};

type ReusableSource = {
  id: string;
  name: string;
  type: 'web' | 'products' | 'product_feed';
  feedType?: 'live_url' | 'static_file';
  promptTemplate?: string;
  url?: string;
  active: boolean;
};

type PromptTemplate = {
  id: string;
  name: string;
  body: string;
  active: boolean;
};

const execEditorCommand = (command: string): void => {
  if (typeof document === 'undefined') {
    return;
  }
  document.execCommand(command);
};

const insertEditorLink = (): void => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return;
  }
  const url = window.prompt('Indsæt URL');
  if (!url) {
    return;
  }
  document.execCommand('createLink', false, url);
};

const DEFAULT_AI_BASE_PROMPT = `Du er en senior e-commerce copywriter og PIM-specialist med dyb forståelse for konverteringsoptimering og SEO.

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
6) Returnér kun den endelige feltværdi — ingen forklaringer, ingen overskrifter, ingen præambel.

Tilgængelige placeholders i prompt:
{{title}}, {{handle}}, {{vendor}}, {{productType}}, {{descriptionHtml}}, {{sku}}, {{barcode}}, {{price}}, {{compareAtPrice}}, {{weight}}, {{weightUnit}}, {{hsCode}}, {{countryOfOrigin}}, {{collections}}`;

const DEFAULT_AI_PROMPT_PRESETS: Array<{ label: string; instruction: string }> = [
  {
    label: 'Produktbeskrivelse',
    instruction: 'Skriv en overbevisende produktbeskrivelse der sætter kunden i centrum. Start med den vigtigste fordel. Beskriv hvad produktet gør, hvem det er til, og hvorfor det er det rigtige valg — uden at opfinde detaljer der ikke fremgår af data. Salgsstærkt, konkret og letlæseligt.',
  },
  {
    label: 'Kort beskrivelse',
    instruction: 'Skriv 2-3 sætninger der fanger essensen: hvad er produktet, hvad gør det, og hvorfor købe det. Direkte, salgsstærkt, ingen fyld.',
  },
  {
    label: 'Metatitel',
    instruction: `Generér en SEO-metatitel. STRENGT KRAV: Resultatet MÅ ABSOLUT IKKE overstige 60 tegn — tæl tegnene inden du returnerer. Primært søgeord tidligt i titlen, produktnavn med, naturligt og klikvenligt. Ingen marketing-snak, ingen udråbstegn. Hvis dit første udkast er over 60 tegn, skær ned og prøv igen, indtil det er inden for grænsen.`,
  },
  {
    label: 'Metabeskrivelse',
    instruction: `Generér en SEO-metabeskrivelse. STRENGT KRAV: Resultatet SKAL være mellem 140 og 160 tegn — tæl tegnene inden du returnerer. Er dit udkast kortere end 140, udvid det. Er det over 160, skær ned. Tydelig kundeværdi + konkret call-to-action. Inkludér primært søgeord naturligt — ingen generiske sætninger.`,
  },
  {
    label: 'FAQ',
    instruction: `TRIN 1 — EVALUER DATA INDEN DU SKRIVER NOGET:
Gennemgå de tilgængelige produktdata. Tæl kun faktuelle detaljer der er direkte angivet: konkrete egenskaber, specifikationer, materialer, kompatibilitet, mål, certifikationer eller lignende. Produktnavn, varenummer, pris og leverandørnavn tæller IKKE som faktuelle detaljer.

Hvis der er FÆRRE END 3 konkrete faktuelle detaljer → returnér udelukkende en tom streng. Ingen FAQ. Ingen forklaring.

TRIN 2 — KUN HVIS DATA ER TILSTRÆKKELIGE:
Generér 3-5 korte FAQ-spørgsmål og svar baseret strengt på de faktuelle detaljer fra trin 1.

Regler:
- Hvert svar skal besvares fuldt ud med konkret information fra kildedata — ikke med "det fremgår ikke" eller lignende.
- Spørg aldrig "hvad er dette produkt?" eller spørgsmål der blot gentager produktnavnet.
- Spørg ikke om pris, lager, levering eller bestilling medmindre det eksplicit fremgår af data.
- Opfind ikke egenskaber, mål, materialer, kompatibilitet, godkendelser eller tekniske specifikationer.
- Undgå generiske vendinger som "høj kvalitet", "optimal ydeevne", "designet til præcis funktionalitet".
- Et svar der primært beskriver hvad der mangler i data er ikke et gyldigt svar — slet spørgsmålet i stedet.`,
  },
];

// Maps built-in field keys and label/key patterns to preset labels
const FIELD_PRESET_MAP: Array<{ match: (key: string, label: string) => boolean; presetLabel: string }> = [
  { match: (k) => k === '_meta_title' || /meta[_\s-]?titel|seo[_\s-]?titel|meta[_\s-]?title|seo[_\s-]?title/.test(k), presetLabel: 'Metatitel' },
  { match: (k) => k === '_meta_description' || /meta[_\s-]?beskriv|seo[_\s-]?beskriv|meta[_\s-]?desc|seo[_\s-]?desc/.test(k), presetLabel: 'Metabeskrivelse' },
  { match: (k) => /faq/.test(k), presetLabel: 'FAQ' },
  { match: (k, l) => /kort[_\s-]?beskriv|short[_\s-]?desc|excerpt|uddrag/.test(k) || /kort[_\s-]?beskriv|short[_\s-]?desc|uddrag/.test(l), presetLabel: 'Kort beskrivelse' },
  { match: (k) => k === '_description' || /beskriv|description|body/.test(k), presetLabel: 'Produktbeskrivelse' },
];

const getAutoPreset = (
  field: { key: string; label: string },
  presets: Array<{ label: string; instruction: string }>,
): { label: string; instruction: string } | null => {
  const key = field.key.toLowerCase();
  const label = field.label.toLowerCase();
  for (const rule of FIELD_PRESET_MAP) {
    if (rule.match(key, label)) {
      return presets.find((p) => p.label === rule.presetLabel) ?? null;
    }
  }
  return null;
};

const RECENT_COMPETITOR_LINKS_KEY = 'epim_recent_competitor_links';

const normalizeCompetitorInput = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parseUrl = (candidate: string): URL | null => {
    try {
      return new URL(candidate);
    } catch {
      return null;
    }
  };

  const direct = parseUrl(trimmed);
  if (direct && (direct.protocol === 'http:' || direct.protocol === 'https:')) {
    return `${direct.protocol}//${direct.hostname}`;
  }

  const prefixed = parseUrl(`https://${trimmed}`);
  if (prefixed && prefixed.hostname.includes('.')) {
    return `https://${prefixed.hostname}`;
  }

  return null;
};

const domainFromUrl = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

const formatRelativeConflict = (dateStr: string): string => {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 2) return 'Lige nu';
  if (diffMins < 60) return `${diffMins} min. siden`;
  if (diffHours < 24) return `${diffHours} t. siden`;
  if (diffDays < 7) return `${diffDays} dag${diffDays !== 1 ? 'e' : ''} siden`;
  return date.toLocaleDateString('da-DK', { day: 'numeric', month: 'short', year: 'numeric' });
};

const stripHtmlTags = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

type DiffRow = { field: string; label: string; epimValue: string; shopifyValue: string; differs: boolean };
const buildConflictDiffRows = (
  product: { title?: string; descriptionHtml?: string; vendor?: string; productType?: string; status?: string; tagsJson?: string[] },
  shopifyData: Partial<{ title: string; descriptionHtml: string; vendor: string; productType: string; status: string; tagsJson: string[] }>,
): DiffRow[] => {
  const rows: Omit<DiffRow, 'differs'>[] = [
    { field: 'title', label: 'Titel', epimValue: product.title ?? '', shopifyValue: shopifyData.title ?? '' },
    { field: 'descriptionHtml', label: 'Beskrivelse', epimValue: stripHtmlTags(product.descriptionHtml ?? ''), shopifyValue: stripHtmlTags(shopifyData.descriptionHtml ?? '') },
    { field: 'vendor', label: 'Leverandør', epimValue: product.vendor ?? '', shopifyValue: shopifyData.vendor ?? '' },
    { field: 'productType', label: 'Produkttype', epimValue: product.productType ?? '', shopifyValue: shopifyData.productType ?? '' },
    { field: 'status', label: 'Status', epimValue: product.status ?? '', shopifyValue: shopifyData.status ?? '' },
    { field: 'tags', label: 'Tags', epimValue: (product.tagsJson ?? []).join(', '), shopifyValue: (shopifyData.tagsJson ?? []).join(', ') },
  ];
  return rows.map((r) => ({ ...r, differs: r.epimValue !== r.shopifyValue }));
};

export default function ProductDetailsPage() {
  const { id } = useParams<{ id: string }>();
  const [product, setProduct] = useState<Product | null>(null);
  const [fields, setFields] = useState<FieldDefinition[]>([]);
  const [warnings, setWarnings] = useState<Array<{ type: string; message: string; fieldDefinitionId?: string }>>([]);
  const htmlEditorRefs = useRef<Record<string, HTMLDivElement | null>>({});
  // Tracks what innerHTML the editor DOM currently shows — used to detect external changes
  const htmlEditorDomValueRef = useRef<Record<string, string>>({});
  const [history, setHistory] = useState<Array<{ id: string; source: string; createdAt: string }>>([]);
  const [detailedHistory, setDetailedHistory] = useState<HistoryLog[]>([]);
  const [historySnapshots, setHistorySnapshots] = useState<HistorySnapshot[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyTab, setHistoryTab] = useState<'changes' | 'snapshots'>('changes');
  const [translationsOpen, setTranslationsOpen] = useState(false);
  const [translations, setTranslations] = useState<Array<{ id: string; locale: string; fieldKey: string; value: string }>>([]);
  const [translationsLoaded, setTranslationsLoaded] = useState(false);
  const [translationLocale, setTranslationLocale] = useState('en');
  const [translationEdits, setTranslationEdits] = useState<Record<string, string>>({});
  const [savingTranslation, setSavingTranslation] = useState(false);
  const [message, setMessage] = useState('');
  const [fieldEdits, setFieldEdits] = useState<Record<string, string>>({});
  const initialFieldEditsRef = useRef<Record<string, string>>({});
  // Committed state: DB values without any draft applied — used for "discard draft"
  const committedFieldEditsRef = useRef<Record<string, string>>({});
  const committedTagsRef = useRef('');

  // Sync external fieldEdits changes (AI suggestion, initial load, mode switch) into editor DOM.
  // User-typed input is skipped: onInput writes back to htmlEditorDomValueRef first, so
  // stateValue === domValue and the effect is a no-op for that field.
  useEffect(() => {
    for (const [fieldId, html] of Object.entries(fieldEdits)) {
      const el = htmlEditorRefs.current[fieldId];
      if (!el) continue;
      const domValue = htmlEditorDomValueRef.current[fieldId] ?? null;
      if (domValue !== html) {
        el.innerHTML = html;
        htmlEditorDomValueRef.current[fieldId] = html;
      }
    }
  }, [fieldEdits]);
  const [tagsInput, setTagsInput] = useState('');
  const initialTagsInputRef = useRef('');
  const [draftSaveStatus, setDraftSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [selectedFieldId, setSelectedFieldId] = useState('');
  const [aiInstruction, setAiInstruction] = useState('Skriv en skarp og SEO-optimeret værdi til det valgte felt, baseret på produktdata.');
  const [aiUseHtmlOutput, setAiUseHtmlOutput] = useState(false);
  const [aiUseWebSearch, setAiUseWebSearch] = useState(false);
  const [competitorLinksInput, setCompetitorLinksInput] = useState('');
  const [aiOutputLength, setAiOutputLength] = useState<'fra' | 'kort' | 'mellem' | 'lang'>('mellem');
  const [aiKeywords, setAiKeywords] = useState('');
  const [aiNegativeKeywords, setAiNegativeKeywords] = useState('');
  const [brandVoiceLock, setBrandVoiceLock] = useState(true);
  const [brandVoiceGuide, setBrandVoiceGuide] = useState('Professionel tone: teknisk kompetent, tillidsvækkende, konkret og handlingsorienteret. Undgå hype og fluffy vendinger.');
  const [recentCompetitorLinks, setRecentCompetitorLinks] = useState<string[]>([]);
  const [keywordSuggestions, setKeywordSuggestions] = useState<KeywordSuggestion[]>([]);
  const [usageTotals, setUsageTotals] = useState<AiUsageSummary | null>(null);
  const [recentUsages, setRecentUsages] = useState<AiUsageLog[]>([]);
  const [reusableSources, setReusableSources] = useState<ReusableSource[]>([]);
  const [savedPrompts, setSavedPrompts] = useState<PromptTemplate[]>([]);
  const [aiPromptPresets, setAiPromptPresets] = useState<Array<{ label: string; instruction: string }>>(DEFAULT_AI_PROMPT_PRESETS);
  const [selectedPromptId, setSelectedPromptId] = useState('');
  const [htmlEditorMode, setHtmlEditorMode] = useState<Record<string, 'visual' | 'source'>>({});
  const [statusEdit, setStatusEdit] = useState<string>('');
  const [variantEdits, setVariantEdits] = useState<Record<string, { sku?: string; price?: string; compareAtPrice?: string; weight?: string; weightUnit?: string; inventoryPolicy?: string; requiresShipping?: boolean; taxable?: boolean; hsCode?: string; countryOfOrigin?: string }>>({});
  const initialVariantEditsRef = useRef<typeof variantEdits>({});
  const [isSaving, setIsSaving] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);
  const [isGeneratingAi, setIsGeneratingAi] = useState(false);
  const [variantAiSuggestLoading, setVariantAiSuggestLoading] = useState<Record<string, boolean>>({});
  const [isSuggestingKeywords, setIsSuggestingKeywords] = useState(false);
  const [activeAiJobId, setActiveAiJobId] = useState<string | null>(null);
  const [aiResultPopup, setAiResultPopup] = useState<{ fieldLabel: string; value: string } | null>(null);
  const [shopifyConflictData, setShopifyConflictData] = useState<Partial<Product> | null>(null);
  const [isFetchingDiff, setIsFetchingDiff] = useState(false);
  const [userPlatformRole, setUserPlatformRole] = useState<string>('none');
  const [userRole, setUserRole] = useState<string>('member');
  const [showStamdata, setShowStamdata] = useState(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem('epim_show_stamdata') !== 'false';
  });
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [sourcesOnly, setSourcesOnly] = useState(false);
  const [aiLaunching, setAiLaunching] = useState(false);
  const [handleEdit, setHandleEdit] = useState('');
  const [liveVsKladdeOpen, setLiveVsKladdeOpen] = useState(false);
  const [inventoryOpen, setInventoryOpen] = useState(false);
  const [imageEdits, setImageEdits] = useState<Array<{ url: string; altText?: string }>>([]);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [lightboxDragIndex, setLightboxDragIndex] = useState<number | null>(null);
  const [addImageUrl, setAddImageUrl] = useState('');
  const [addImagePopoverOpen, setAddImagePopoverOpen] = useState(false);
  const [vendorEdit, setVendorEdit] = useState('');
  const [productTypeEdit, setProductTypeEdit] = useState('');
  const [publications, setPublications] = useState<Array<{ id: string; name: string; isPublished: boolean }>>([]);
  const [publicationsLoading, setPublicationsLoading] = useState(false);
  const [fieldMappingDetails, setFieldMappingDetails] = useState<Map<string, { targetType: string; targetJson: Record<string, unknown> }>>(new Map());
  const [lockPopoverId, setLockPopoverId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'indhold' | 'varianter' | 'oversaettelser' | 'historik'>('indhold');
  const [felterOpen, setFelterOpen] = useState(true);
  const [shopLocales, setShopLocales] = useState<Array<{ locale: string; name: string; primary: boolean; published: boolean }>>([]);

  // Close lock popover on outside click
  useEffect(() => {
    if (!lockPopoverId) return;
    const handler = () => setLockPopoverId(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [lockPopoverId]);

  // Auto-load history when historik tab is opened (once only)
  const historyLoadedRef = useRef(false);
  useEffect(() => {
    if (activeTab !== 'historik' || historyLoadedRef.current || !product) return;
    historyLoadedRef.current = true;
    apiFetch<{ logs: HistoryLog[]; snapshots: HistorySnapshot[] }>(`/products/${product.id}/history`)
      .then((res) => { setDetailedHistory(res.logs); setHistorySnapshots(res.snapshots); })
      .catch(() => {});
  }, [activeTab, product]);

  // Load translations when oversaettelser tab is opened
  useEffect(() => {
    if (activeTab !== 'oversaettelser' || translationsLoaded || !product) return;
    apiFetch<{ translations: Array<{ id: string; locale: string; fieldKey: string; value: string }> }>(`/products/${product.id}/translations`)
      .then((res) => {
        setTranslations(res.translations);
        const edits: Record<string, string> = {};
        for (const t of res.translations) edits[`${t.locale}__${t.fieldKey}`] = t.value;
        setTranslationEdits(edits);
        setTranslationsLoaded(true);
      })
      .catch(() => setTranslationsLoaded(true));
  }, [activeTab, translationsLoaded, product]);

  const loadUsage = async (productId: string): Promise<void> => {
    try {
      const response = await apiFetch<{ totals: AiUsageSummary; usages: AiUsageLog[] }>(`/products/${productId}/resource-usage`);
      setUsageTotals(response.totals);
      setRecentUsages(response.usages.slice(0, 6));
    } catch {
      setUsageTotals(null);
      setRecentUsages([]);
    }
  };

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      const stored = window.localStorage.getItem(RECENT_COMPETITOR_LINKS_KEY);
      if (!stored) {
        return;
      }
      const parsed = JSON.parse(stored) as string[];
      if (Array.isArray(parsed)) {
        setRecentCompetitorLinks(parsed.filter((item) => typeof item === 'string'));
      }
    } catch {
      setRecentCompetitorLinks([]);
    }
  }, []);

  useEffect(() => {
    const selectedField = fields.find((field) => field.id === selectedFieldId);
    if (selectedField?.type === 'html') {
      setAiUseHtmlOutput(true);
    }
  }, [fields, selectedFieldId]);

  const openAiModalForField = useCallback((fieldId: string) => {
    setSelectedFieldId(fieldId);
    const field = fields.find((f) => f.id === fieldId);
    if (field) {
      const preset = getAutoPreset(field, aiPromptPresets);
      if (preset) {
        setAiInstruction(preset.instruction);
      }
    }
    setAiModalOpen(true);
  }, [fields, aiPromptPresets]);

  useEffect(() => {
    Promise.all([
      apiFetch<{ product: Product }>(`/products/${id}`),
      apiFetch<{ fields: FieldDefinition[] }>('/fields'),
      apiFetch<{ warnings: Array<{ type: string; message: string }> }>(`/warnings?entityId=${id}`),
      apiFetch<{ logs: Array<{ id: string; source: string; createdAt: string }> }>(`/changelog?entityId=${id}`),
      apiFetch<{ sources: ReusableSource[] }>('/sources'),
      apiFetch<{ prompts: PromptTemplate[] }>('/prompts'),
      apiFetch<{ settings: Array<{ key: string; valueJson: unknown }> }>('/settings'),
      apiFetch<{ user: { platformRole?: string; role?: string } | null }>('/me'),
      apiFetch<{ mappings: Array<{ fieldDefinitionId: string; direction: string; targetType: string; targetJson: Record<string, unknown> }> }>('/mappings'),
      apiFetch<{ drafts: Array<{ patchJson: Record<string, unknown> }> }>(`/drafts?entityType=product&entityId=${id}`),
      apiFetch<{ quickPresets: Array<{ label: string; instruction: string }> | null }>('/shops/ai-settings').catch(() => ({ quickPresets: null })),
    ])
      .then(([productResponse, fieldResponse, warningResponse, logResponse, sourceResponse, promptsResponse, settingsResponse, meResponse, mappingResponse, draftResponse, aiSettingsResponse]) => {
        setProduct(productResponse.product);
        document.title = `${productResponse.product.title} | ePIM`;
        setStatusEdit(productResponse.product.status ?? 'DRAFT');
        setHandleEdit(productResponse.product.handle ?? '');
        setVendorEdit(productResponse.product.vendor ?? '');
        setProductTypeEdit(productResponse.product.productType ?? '');
        setImageEdits(productResponse.product.imagesJson ?? []);
        const initVariants: Record<string, { sku?: string; price?: string; compareAtPrice?: string; weight?: string; weightUnit?: string; inventoryPolicy?: string; requiresShipping?: boolean; taxable?: boolean; hsCode?: string; countryOfOrigin?: string }> = {};
        for (const v of productResponse.product.variants ?? []) {
          initVariants[v.id] = {
            sku: v.sku ?? '',
            price: v.price ?? '',
            compareAtPrice: v.compareAtPrice ?? '',
            weight: v.weight != null ? String(v.weight) : '',
            weightUnit: v.weightUnit ?? 'KILOGRAMS',
            inventoryPolicy: v.inventoryPolicy ?? 'DENY',
            requiresShipping: v.requiresShipping ?? true,
            taxable: v.taxable ?? true,
            hsCode: v.hsCode ?? '',
            countryOfOrigin: v.countryOfOrigin ?? '',
          };
        }
        setVariantEdits(initVariants);
        initialVariantEditsRef.current = initVariants;
        const productFields = fieldResponse.fields.filter((field) => field.scope === 'product');
        setFields(productFields);
        setWarnings(warningResponse.warnings);
        setHistory(logResponse.logs);

        const initialEdits: Record<string, string> = {};
        for (const field of productFields) {
          const fieldValue = productResponse.product.fieldValues?.find((value) => value.fieldDefinitionId === field.id)?.valueJson;
          if (fieldValue != null) {
            initialEdits[field.id] = String(fieldValue);
          } else if (field.key === '_title') {
            initialEdits[field.id] = productResponse.product.title ?? '';
          } else if (field.key === '_description') {
            initialEdits[field.id] = productResponse.product.descriptionHtml ?? '';
          } else if (field.key === '_meta_title') {
            initialEdits[field.id] = productResponse.product.seoJson?.title ?? '';
          } else if (field.key === '_meta_description') {
            initialEdits[field.id] = productResponse.product.seoJson?.description ?? '';
          } else {
            initialEdits[field.id] = '';
          }
        }

        // Capture committed state BEFORE applying draft (used by discardDraft)
        committedFieldEditsRef.current = { ...initialEdits };
        const committedTags = (productResponse.product.tagsJson ?? []).join(', ');
        committedTagsRef.current = committedTags;

        // Hydrate local edits from saved draft (supports both key-based and id-based patchJson)
        const latestDraftPatch = draftResponse.drafts[0]?.patchJson ?? {};
        const byKey = new Map(productFields.map((f) => [f.key, f]));
        for (const [draftKey, draftValue] of Object.entries(latestDraftPatch)) {
          const byIdField = productFields.find((f) => f.id === draftKey);
          if (byIdField) {
            initialEdits[byIdField.id] = String(draftValue ?? '');
            continue;
          }
          const byKeyField = byKey.get(draftKey);
          if (byKeyField) {
            initialEdits[byKeyField.id] = String(draftValue ?? '');
          }
        }

        setFieldEdits(initialEdits);
        initialFieldEditsRef.current = { ...initialEdits };
        setHasDraft(draftResponse.drafts.length > 0);
        // Tags: prefer draft value over committed product value
        const draftTags = typeof latestDraftPatch.tags === 'string' ? latestDraftPatch.tags : null;
        const initialTags = draftTags ?? committedTags;
        setTagsInput(initialTags);
        initialTagsInputRef.current = initialTags;
        setDraftSaveStatus('idle');

        const mappingDetailsMap = new Map(
          mappingResponse.mappings
            .filter((m) => m.direction === 'PIM_TO_SHOPIFY' || m.direction === 'TWO_WAY')
            .map((m) => [m.fieldDefinitionId, { targetType: m.targetType, targetJson: m.targetJson }])
        );
        setFieldMappingDetails(mappingDetailsMap);
        if (productFields[0]) {
          setSelectedFieldId(productFields[0].id);
        }

        setReusableSources(sourceResponse.sources.filter((source) => source.active));
        const activePrompts = promptsResponse.prompts.filter((prompt) => prompt.active);
        setSavedPrompts(activePrompts);
        if (activePrompts[0]) {
          setSelectedPromptId(activePrompts[0].id);
        }

        const settingsMap = settingsResponse.settings.reduce<Record<string, unknown>>((acc, item) => {
          acc[item.key] = item.valueJson;
          return acc;
        }, {});
        setBrandVoiceLock(String(settingsMap.brandVoiceLock ?? 'true') !== 'false');
        setBrandVoiceGuide(
          String(
            settingsMap.brandVoiceGuide ??
              'Professionel tone: teknisk kompetent, tillidsvækkende, konkret og handlingsorienteret. Undgå hype og fluffy vendinger.',
          ),
        );

        setUserPlatformRole(meResponse.user?.platformRole ?? 'none');
        setUserRole(meResponse.user?.role ?? 'member');
        if (aiSettingsResponse.quickPresets) {
          const productPresets = (aiSettingsResponse.quickPresets as Array<{ label: string; instruction: string; scope?: string }>).filter((p) => !p.scope || p.scope === 'product');
          if (productPresets.length > 0) setAiPromptPresets(productPresets);
        }

        void loadUsage(productResponse.product.id);
        apiFetch<{ locales: Array<{ locale: string; name: string; primary: boolean; published: boolean }> }>('/shops/locales')
          .then((res) => setShopLocales(res.locales.filter((l) => !l.primary)))
          .catch(() => {});
      })
      .catch(() => {
        setProduct(null);
      });
  }, [id]);

  useEffect(() => {
    if (!product?.shopifyProductGid || !product?.id) return;
    setPublicationsLoading(true);
    apiFetch<{ publications: Array<{ id: string; name: string; isPublished: boolean }> }>(`/products/${product.id}/publications`)
      .then((r) => setPublications(r.publications))
      .catch(() => setPublications([]))
      .finally(() => setPublicationsLoading(false));
  }, [product?.id, product?.shopifyProductGid]);

  useEffect(() => {
    if (!activeAiJobId || !product) {
      return;
    }

    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const status = await apiFetch<{ jobs: Array<{ id: string; status: string; error?: string | null }> }>('/sync-jobs/status', {
          method: 'POST',
          body: JSON.stringify({ jobIds: [activeAiJobId] }),
        });

        if (cancelled) {
          return;
        }

        const job = status.jobs[0];
        if (!job) {
          return;
        }

        if (job.status === 'done') {
          const refreshed = await apiFetch<{ product: Product }>(`/products/${product.id}`);
          if (cancelled) {
            return;
          }
          setProduct(refreshed.product);
          const selectedField = fields.find((field) => field.id === selectedFieldId);
          const latestValue = refreshed.product.fieldValues?.find((value) => value.fieldDefinitionId === selectedFieldId)?.valueJson;
          const valueText = latestValue == null ? '' : String(latestValue);
          setFieldEdits((prev) => ({ ...prev, [selectedFieldId]: valueText }));
          setAiResultPopup({ fieldLabel: selectedField?.label ?? 'Felt', value: valueText });
          setActiveAiJobId(null);
          void loadUsage(product.id);
          return;
        }

        if (job.status === 'failed') {
          setMessage(job.error ?? 'AI job fejlede.');
          setActiveAiJobId(null);
        }
      } catch {
        return;
      }
    };

    void poll();
    const intervalId = setInterval(() => void poll(), 1000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [activeAiJobId, fields, product, selectedFieldId]);

  const placeholderHelp = useMemo(
    () => ['{{title}}', '{{handle}}', '{{vendor}}', '{{productType}}', '{{descriptionHtml}}', '{{sku}}', '{{barcode}}', '{{price}}', '{{compareAtPrice}}', '{{collections}}'],
    [],
  );

  const aiPrompt = useMemo(() => {
    const fieldLabel = fields.find((field) => field.id === selectedFieldId)?.label ?? 'Valgt felt';
    const htmlInstruction = aiUseHtmlOutput
      ? '\n\nHTML FORMATERING AKTIVERET:\nStrukturér og opstil outputtet med semantisk HTML (fx <p>, <h2>, <ul>/<li>, <strong>). Brug HTML til at skabe overskuelighed og hierarki. Returnér kun HTML-koden uden wrapper-elementer.'
      : '';
    const webSearchInstruction = aiUseWebSearch
      ? '\n\nWEB SØGNING AKTIVERET:\nDu må aktivt søge på web for opdateret kontekst og formulering.'
      : '';
    const lengthInstruction = aiOutputLength !== 'fra' ? `\n\nØNSKET LÆNGDE: ${aiOutputLength}` : '';
    const keywords = aiKeywords
      .split(',')
      .map((keyword) => keyword.trim())
      .filter(Boolean);
    const keywordInstruction = keywords.length
      ? `\n\nSEO NØGLEORD (brug naturligt): ${keywords.join(', ')}`
      : '';
    const negativeKeywords = aiNegativeKeywords
      .split(',')
      .map((keyword) => keyword.trim())
      .filter(Boolean);
    const negativeKeywordInstruction = negativeKeywords.length
      ? `\n\nNEGATIVE KEYWORDS (undgå disse): ${negativeKeywords.join(', ')}`
      : '';
    const brandVoiceInstruction = brandVoiceLock
      ? `\n\nBRAND VOICE LOCK (obligatorisk):\n${brandVoiceGuide}`
      : '';

    const competitorInputs = competitorLinksInput
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const normalizedCompetitors = competitorInputs
      .map((input) => normalizeCompetitorInput(input))
      .filter((value): value is string => Boolean(value));
    const competitorDomains = normalizedCompetitors.map((url) => domainFromUrl(url));
    const competitorInstruction = competitorDomains.length
      ? `\n\nKONKURRENT-DOMÆNER (find selv relevante sider):\n${competitorDomains.map((domain) => `- ${domain}`).join('\n')}\nSøg aktivt på disse domæner (fx med site:${competitorDomains[0]} + relevante produktord), og brug fundene som inspiration uden at kopiere direkte.`
      : '';

    const activeSourcesToShow = selectedSourceIds.length > 0
      ? reusableSources.filter((s) => selectedSourceIds.includes(s.id))
      : reusableSources.filter((s) => s.feedType === 'static_file' || s.type === 'products');

    const sourcePreview = activeSourcesToShow.length > 0
      ? `\n\n--- DATAKILDER (injiceres ved generering) ---\n${activeSourcesToShow
          .map((s) => `[${s.name}]: ${s.promptTemplate ?? 'Standard datakilde-prompt'}`)
          .join('\n')}`
      : '';

    const sourcesOnlyPreview = sourcesOnly && activeSourcesToShow.length > 0
      ? '\n\nVIGTIGT — BRUG UDELUKKENDE KILDEDATA: Brug kun information fra kildedataene.'
      : '';

    return `${DEFAULT_AI_BASE_PROMPT}\n\nFELT DU SKAL GENERERE TIL: ${fieldLabel}\n\nSUPPLERENDE INSTRUKTION:\n${aiInstruction}${lengthInstruction}${keywordInstruction}${negativeKeywordInstruction}${brandVoiceInstruction}${htmlInstruction}${webSearchInstruction}${competitorInstruction}${sourcePreview}${sourcesOnlyPreview}`;
  }, [
    aiInstruction,
    aiKeywords,
    aiNegativeKeywords,
    aiOutputLength,
    brandVoiceGuide,
    brandVoiceLock,
    aiUseHtmlOutput,
    aiUseWebSearch,
    competitorLinksInput,
    fields,
    reusableSources,
    selectedFieldId,
    selectedSourceIds,
    sourcesOnly,
  ]);

  const competitorUrlLines = useMemo(
    () => competitorLinksInput.split('\n').map((line) => line.trim()).filter(Boolean),
    [competitorLinksInput],
  );

  const parsedCompetitorUrls = useMemo(
    () =>
      competitorUrlLines.map((value) => {
        const normalized = normalizeCompetitorInput(value);
        return {
          value,
          normalized,
          valid: Boolean(normalized),
        };
      }),
    [competitorUrlLines],
  );

  const validCompetitorUrls = useMemo(
    () => Array.from(new Set(parsedCompetitorUrls.filter((item) => item.valid).map((item) => item.normalized as string))),
    [parsedCompetitorUrls],
  );

  const refreshHistory = useCallback(async (productId: string): Promise<void> => {
    try {
      const [logRes, histRes] = await Promise.all([
        apiFetch<{ logs: Array<{ id: string; source: string; createdAt: string }> }>(`/changelog?entityId=${productId}`),
        apiFetch<{ logs: HistoryLog[]; snapshots: HistorySnapshot[] }>(`/products/${productId}/history`),
      ]);
      setHistory(logRes.logs);
      setDetailedHistory(histRes.logs);
      setHistorySnapshots(histRes.snapshots);
    } catch {
      // ignore
    }
  }, []);

  const saveFieldValues = useCallback(async (): Promise<void> => {
    if (!product) {
      return;
    }

    setIsSaving(true);
    try {
      const titleField = fields.find((f) => f.key === '_title');
      const descField = fields.find((f) => f.key === '_description');
      const metaTitleField = fields.find((f) => f.key === '_meta_title');
      const metaDescField = fields.find((f) => f.key === '_meta_description');
      const response = await apiFetch<{ product: Product }>(`/products/${product.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          tagsJson: tagsInput
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
          fieldValues: fields.map((field) => ({
            fieldDefinitionId: field.id,
            valueJson: fieldEdits[field.id] ?? '',
          })),
          title: titleField ? (fieldEdits[titleField.id] ?? undefined) : undefined,
          descriptionHtml: descField ? (fieldEdits[descField.id] ?? undefined) : undefined,
          seoJson: (metaTitleField || metaDescField) ? {
            title: metaTitleField ? (fieldEdits[metaTitleField.id] ?? '') : undefined,
            description: metaDescField ? (fieldEdits[metaDescField.id] ?? '') : undefined,
          } : undefined,
          handle: handleEdit,
          status: statusEdit,
          vendor: vendorEdit,
          productType: productTypeEdit,
          imagesJson: imageEdits,
          syncNow: false,
        }),
      });
      setProduct(response.product);
      setImageEdits(response.product.imagesJson ?? []);
      initialTagsInputRef.current = tagsInput;
      initialFieldEditsRef.current = { ...fieldEdits };
      // Save changed variants
      const changedVariants = Object.entries(variantEdits).filter(([id, edits]) => {
        const init = initialVariantEditsRef.current[id] ?? {};
        return Object.entries(edits).some(([key, val]) => String(val ?? '') !== String((init as Record<string, unknown>)[key] ?? ''));
      });
      for (const [variantId, edits] of changedVariants) {
        await apiFetch(`/variants/${variantId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            ...(edits.sku !== undefined ? { sku: edits.sku } : {}),
            ...(edits.price !== undefined ? { price: edits.price } : {}),
            ...(edits.compareAtPrice !== undefined ? { compareAtPrice: edits.compareAtPrice } : {}),
            weight: edits.weight ? Number(edits.weight) : undefined,
            weightUnit: edits.weightUnit || undefined,
            inventoryPolicy: edits.inventoryPolicy || undefined,
            requiresShipping: edits.requiresShipping,
            taxable: edits.taxable,
            ...(edits.hsCode !== undefined ? { hsCode: edits.hsCode } : {}),
            ...(edits.countryOfOrigin !== undefined ? { countryOfOrigin: edits.countryOfOrigin } : {}),
          }),
        });
      }
      if (changedVariants.length > 0) {
        initialVariantEditsRef.current = { ...variantEdits };
      }
      setDraftSaveStatus('idle');
      setHasDraft(false);
      apiFetch(`/drafts/product/${product.id}`, { method: 'DELETE' }).catch(() => {});
      void refreshHistory(product.id);
      toast.success('Feltværdier gemt.');
    } catch {
      toast.error('Kunne ikke gemme feltværdier.');
    } finally {
      setIsSaving(false);
    }
  }, [product, tagsInput, fieldEdits, fields, statusEdit, variantEdits, imageEdits, vendorEdit, productTypeEdit, refreshHistory]);

  const discardDraft = useCallback(async (): Promise<void> => {
    if (!product) return;
    const committed = committedFieldEditsRef.current;
    setFieldEdits({ ...committed });
    initialFieldEditsRef.current = { ...committed };
    setTagsInput(committedTagsRef.current);
    initialTagsInputRef.current = committedTagsRef.current;
    setStatusEdit(product.status ?? 'DRAFT');
    setVariantEdits({ ...initialVariantEditsRef.current });
    setImageEdits([...(product.imagesJson ?? [])]);
    setVendorEdit(product.vendor ?? '');
    setProductTypeEdit(product.productType ?? '');
    setHandleEdit(product.handle ?? '');
    setDraftSaveStatus('idle');
    setHasDraft(false);
    await apiFetch(`/drafts/product/${product.id}`, { method: 'DELETE' }).catch(() => {});
    toast.success('Kladde kasseret.');
  }, [product]);

  const saveAndSyncToShopify = async (): Promise<void> => {
    if (!product) return;
    setIsSaving(true);
    try {
      const titleField = fields.find((f) => f.key === '_title');
      const descField = fields.find((f) => f.key === '_description');
      const metaTitleField = fields.find((f) => f.key === '_meta_title');
      const metaDescField = fields.find((f) => f.key === '_meta_description');
      const response = await apiFetch<{ product: Product; syncJobId?: string | null }>(`/products/${product.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          tagsJson: tagsInput
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
          fieldValues: fields.map((field) => ({
            fieldDefinitionId: field.id,
            valueJson: fieldEdits[field.id] ?? '',
          })),
          title: titleField ? (fieldEdits[titleField.id] ?? undefined) : undefined,
          descriptionHtml: descField ? (fieldEdits[descField.id] ?? undefined) : undefined,
          seoJson: (metaTitleField || metaDescField) ? {
            title: metaTitleField ? (fieldEdits[metaTitleField.id] ?? '') : undefined,
            description: metaDescField ? (fieldEdits[metaDescField.id] ?? '') : undefined,
          } : undefined,
          handle: handleEdit,
          status: statusEdit,
          vendor: vendorEdit,
          productType: productTypeEdit,
          imagesJson: imageEdits,
          syncNow: true,
        }),
      });
      setProduct(response.product);
      setImageEdits(response.product.imagesJson ?? []);
      initialTagsInputRef.current = tagsInput;
      initialFieldEditsRef.current = { ...fieldEdits };
      // Save changed variants
      const changedVariants = Object.entries(variantEdits).filter(([id, edits]) => {
        const init = initialVariantEditsRef.current[id] ?? {};
        return Object.entries(edits).some(([key, val]) => String(val ?? '') !== String((init as Record<string, unknown>)[key] ?? ''));
      });
      for (const [variantId, edits] of changedVariants) {
        await apiFetch(`/variants/${variantId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            ...(edits.sku !== undefined ? { sku: edits.sku } : {}),
            ...(edits.price !== undefined ? { price: edits.price } : {}),
            ...(edits.compareAtPrice !== undefined ? { compareAtPrice: edits.compareAtPrice } : {}),
            weight: edits.weight ? Number(edits.weight) : undefined,
            weightUnit: edits.weightUnit || undefined,
            inventoryPolicy: edits.inventoryPolicy || undefined,
            requiresShipping: edits.requiresShipping,
            taxable: edits.taxable,
            ...(edits.hsCode !== undefined ? { hsCode: edits.hsCode } : {}),
            ...(edits.countryOfOrigin !== undefined ? { countryOfOrigin: edits.countryOfOrigin } : {}),
          }),
        });
      }
      if (changedVariants.length > 0) {
        initialVariantEditsRef.current = { ...variantEdits };
      }
      setDraftSaveStatus('idle');
      apiFetch(`/drafts/product/${product.id}`, { method: 'DELETE' }).catch(() => {});
      if (response.syncJobId) {
        registerBackgroundActivityJobs([response.syncJobId]);
      }
      void refreshHistory(product.id);
      toast.success('Feltværdier gemt og sendt til Shopify sync-køen.');
    } catch {
      toast.error('Kunne ikke gemme og synkronisere.');
    } finally {
      setIsSaving(false);
    }
  };

  const setFieldLockLevel = async (fieldId: string, lockLevel: 'none' | 'users' | 'all'): Promise<void> => {
    setLockPopoverId(null);
    try {
      const res = await apiFetch<{ field: FieldDefinition }>(`/fields/${fieldId}/lock`, {
        method: 'PATCH',
        body: JSON.stringify({ lockLevel }),
      });
      setFields((prev) => prev.map((f) => (f.id === fieldId ? { ...f, lockLevel: res.field.lockLevel } : f)));
    } catch {
      toast.error('Kunne ikke ændre feltlåsning.');
    }
  };

  const pullFromShopify = async (): Promise<void> => {
    if (!product) return;
    setIsSaving(true);
    try {
      const res = await apiFetch<{ product: Product; applied?: boolean; error?: string; shopifyData?: Partial<Product> }>(
        `/products/${product.id}/pull-shopify`,
        { method: 'POST' },
      );
      if (res.product) {
        setProduct(res.product);
        const refreshedTags = (res.product.tagsJson ?? []).join(', ');
        setTagsInput(refreshedTags);
        initialTagsInputRef.current = refreshedTags;
        setHandleEdit(res.product.handle ?? '');
        void refreshHistory(product.id);
        toast.success('Produktdata hentet og opdateret fra Shopify.');
      }
    } catch (err) {
      // 409 conflict: Shopify has data but ePIM has local changes
      if (err instanceof Error) {
        try {
          const parsed = JSON.parse(err.message) as { error?: string; message?: string; shopifyData?: Partial<Product> };
          if (parsed.error === 'conflict') {
            setShopifyConflictData(parsed.shopifyData ?? null);
            return;
          }
          setMessage(parsed.message ?? err.message);
        } catch {
          setMessage(err.message);
        }
      } else {
        setMessage('Kunne ikke hente data fra Shopify.');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const acceptShopifyData = async (): Promise<void> => {
    if (!product) return;
    setIsSaving(true);
    try {
      const res = await apiFetch<{ product: Product }>(`/products/${product.id}/accept-shopify`, { method: 'POST' });
      setProduct(res.product);
      const refreshedTags = (res.product.tagsJson ?? []).join(', ');
      setTagsInput(refreshedTags);
      initialTagsInputRef.current = refreshedTags;
      setHandleEdit(res.product.handle ?? '');
      setShopifyConflictData(null);
      void refreshHistory(product.id);
      toast.success('Shopify-data accepteret og anvendt.');
    } catch {
      toast.error('Kunne ikke acceptere Shopify-data.');
    } finally {
      setIsSaving(false);
    }
  };

  const fetchConflictDiff = async (): Promise<void> => {
    if (!product || isFetchingDiff) return;
    setIsFetchingDiff(true);
    try {
      await apiFetch(`/products/${product.id}/pull-shopify`, { method: 'POST' });
    } catch (err) {
      if (err instanceof Error) {
        try {
          const parsed = JSON.parse(err.message) as { error?: string; shopifyData?: Partial<Product> };
          if (parsed.error === 'conflict' && parsed.shopifyData) {
            setShopifyConflictData(parsed.shopifyData);
          }
        } catch { /* ignore */ }
      }
    } finally {
      setIsFetchingDiff(false);
    }
  };

  // Auto-save draft: debounce 2 seconds after field edits change
  const hasFieldChanges = useCallback((): boolean => {
    const initial = initialFieldEditsRef.current;
    return Object.keys(fieldEdits).some((key) => (fieldEdits[key] ?? '') !== (initial[key] ?? ''));
  }, [fieldEdits]);

  const hasTagChanges = useMemo(() => tagsInput !== initialTagsInputRef.current, [tagsInput]);

  useEffect(() => {
    if (!product) return;
    const changedFields = fields.filter((f) => (fieldEdits[f.id] ?? '') !== (initialFieldEditsRef.current[f.id] ?? ''));
    const tagsChanged = tagsInput !== initialTagsInputRef.current;
    const statusChanged = statusEdit !== '' && statusEdit !== (product.status ?? 'DRAFT');
    const changedVariantPatches = Object.entries(variantEdits).filter(([id, edits]) => {
      const init = initialVariantEditsRef.current[id] ?? {};
      return Object.entries(edits).some(([key, val]) => String(val ?? '') !== String((init as Record<string, unknown>)[key] ?? ''));
    });
    if (changedFields.length === 0 && !tagsChanged && !statusChanged && changedVariantPatches.length === 0) return;
    setDraftSaveStatus('idle');
    const timeoutId = setTimeout(() => {
      const patchJson: Record<string, unknown> = {};
      for (const f of changedFields) {
        patchJson[f.key] = fieldEdits[f.id] ?? '';
      }
      if (tagsChanged) {
        patchJson.tags = tagsInput;
      }
      if (statusChanged) {
        patchJson.status = statusEdit;
      }
      if (changedVariantPatches.length > 0) {
        patchJson.variantPatches = JSON.stringify(changedVariantPatches.map(([id, edits]) => ({ id, ...edits })));
      }
      setDraftSaveStatus('saving');
      apiFetch('/drafts', {
        method: 'PUT',
        body: JSON.stringify({ entityType: 'product', entityId: product.id, patchJson }),
      }).then(() => {
        setDraftSaveStatus('saved');
      }).catch(() => {
        setDraftSaveStatus('idle');
      });
    }, 2000);
    return () => clearTimeout(timeoutId);
  }, [fieldEdits, tagsInput, product, fields, statusEdit, variantEdits]);

  const hasVariantChanges = useMemo(() => {
    return Object.entries(variantEdits).some(([id, edits]) => {
      const init = initialVariantEditsRef.current[id] ?? {};
      return Object.entries(edits).some(([key, val]) => String(val ?? '') !== String((init as Record<string, unknown>)[key] ?? ''));
    });
  }, [variantEdits]);

  const hasStatusChanges = statusEdit !== '' && product != null && statusEdit !== (product.status ?? 'DRAFT');

  const hasHandleChanges = handleEdit !== (product?.handle ?? '');
  const hasImageChanges = JSON.stringify(imageEdits) !== JSON.stringify(product?.imagesJson ?? []);
  const hasVendorChanges = vendorEdit !== (product?.vendor ?? '');
  const hasProductTypeChanges = productTypeEdit !== (product?.productType ?? '');
  const hasUnsavedChanges = hasFieldChanges() || hasTagChanges || hasVariantChanges || hasStatusChanges || hasHandleChanges || hasImageChanges || hasVendorChanges || hasProductTypeChanges;

  const isPendingSync = useMemo(() => {
    if (!product || !product.shopifyProductGid) return false;
    if (!product.lastShopifySyncAt) return true; // linked but never synced
    const lastSync = new Date(product.lastShopifySyncAt).getTime();
    const updatedAt = product.updatedAt ? new Date(product.updatedAt).getTime() : 0;
    return updatedAt > lastSync + 500;
  }, [product]);

  const isConflict = useMemo(() => {
    if (!product?.lastShopifySyncAt || !product.shopifyProductGid) return false;
    const lastSync = new Date(product.lastShopifySyncAt).getTime();
    const localUpdated = product.updatedAt ? new Date(product.updatedAt).getTime() : 0;
    const shopifyUpdated = product.shopifyUpdatedAt ? new Date(product.shopifyUpdatedAt).getTime() : 0;
    return localUpdated > lastSync + 1000 && shopifyUpdated > lastSync + 1000;
  }, [product]);

  // Warn on navigation when there are unsaved changes (and flush pending draft save)
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const handler = (e: BeforeUnloadEvent) => {
      // Draft already saved — no data loss risk, no warning needed
      if (draftSaveStatus === 'saved' || draftSaveStatus === 'saving') return;
      // Flush pending draft via keepalive fetch so data survives the reload
      if (product) {
        const patchJson: Record<string, string> = {};
        for (const f of fields) {
          if ((fieldEdits[f.id] ?? '') !== (initialFieldEditsRef.current[f.id] ?? '')) {
            patchJson[f.key] = fieldEdits[f.id] ?? '';
          }
        }
        if (tagsInput !== initialTagsInputRef.current) {
          patchJson.tags = tagsInput;
        }
        if (Object.keys(patchJson).length > 0) {
          const token = getToken();
          const shopId = getActiveShopId();
          void fetch(`${API_URL}/drafts`, {
            method: 'PUT',
            keepalive: true,
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              ...(shopId ? { 'X-EPIM-Shop-Id': shopId } : {}),
            },
            body: JSON.stringify({ entityType: 'product', entityId: product.id, patchJson }),
          });
        }
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsavedChanges, draftSaveStatus, product, fields, fieldEdits, tagsInput]);

  // Cmd+S / Ctrl+S shortcut → save draft
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (hasUnsavedChanges && !isSaving) void saveFieldValues();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [hasUnsavedChanges, isSaving, saveFieldValues]);

  // Lightbox keyboard navigation
  useEffect(() => {
    if (lightboxIndex === null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setLightboxIndex(null);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setLightboxIndex((prev) => prev === null ? null : (prev - 1 + imageEdits.length) % imageEdits.length);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setLightboxIndex((prev) => prev === null ? null : (prev + 1) % imageEdits.length);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [lightboxIndex, imageEdits.length]);

  const runAiForSelectedField = async (): Promise<void> => {
    if (!product || !selectedFieldId) {
      setMessage('Vælg et felt først.');
      return;
    }

    setIsGeneratingAi(true);
    try {
      const response = await apiFetch<{ jobId: string }>('/ai/apply', {
        method: 'POST',
        body: JSON.stringify({
          rows: [{ ownerType: 'product', ownerId: product.id }],
          fieldDefinitionId: selectedFieldId,
          promptTemplate: aiPrompt,
          webSearch: aiUseWebSearch || validCompetitorUrls.length > 0,
          competitorUrls: validCompetitorUrls,
          sourceIds: selectedSourceIds,
          sourcesOnly,
        }),
      });

      if (typeof window !== 'undefined' && validCompetitorUrls.length > 0) {
        const merged = Array.from(new Set([...validCompetitorUrls, ...recentCompetitorLinks])).slice(0, 10);
        setRecentCompetitorLinks(merged);
        window.localStorage.setItem(RECENT_COMPETITOR_LINKS_KEY, JSON.stringify(merged));
      }

      registerBackgroundActivityJobs([response.jobId]);
      setActiveAiJobId(response.jobId);
      setMessage('AI-generering startet i baggrunden. Se baggrundsaktivitet i højre hjørne.');
    } catch (error) {
      const fallback = 'Kunne ikke starte AI-generering. Tjek at OpenAI API key er sat.';
      if (error instanceof Error) {
        setMessage(error.message || fallback);
      } else {
        setMessage(fallback);
      }
    } finally {
      setIsGeneratingAi(false);
    }
  };

  const suggestKeywords = async (): Promise<void> => {
    if (!product) {
      return;
    }

    setIsSuggestingKeywords(true);
    try {
      const response = await apiFetch<{ suggestions: KeywordSuggestion[]; usage?: AiUsageSummary }>('/ai/keywords/suggest', {
        method: 'POST',
        body: JSON.stringify({
          productId: product.id,
          competitorUrls: validCompetitorUrls,
          maxSuggestions: 10,
          locale: 'da-DK',
        }),
      });
      setKeywordSuggestions(response.suggestions);
      if (response.usage) {
        setMessage(`Keyword research kostede ca. ${response.usage.estimatedCostDkk.toFixed(2)} DKK.`);
        void loadUsage(product.id);
      }
      if (!response.suggestions.length) {
        setMessage('Ingen nøgleordsforslag fundet for produktet.');
      }
    } catch (error) {
      if (error instanceof Error) {
        setMessage(error.message);
      } else {
        setMessage('Kunne ikke hente SEO nøgleordsforslag.');
      }
    } finally {
      setIsSuggestingKeywords(false);
    }
  };

  const addKeyword = (keyword: string): void => {
    const current = aiKeywords
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (current.includes(keyword)) {
      return;
    }
    const merged = [...current, keyword];
    setAiKeywords(merged.join(', '));
  };

  const addAllKeywords = (): void => {
    const current = aiKeywords
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    const merged = Array.from(new Set([...current, ...keywordSuggestions.map((suggestion) => suggestion.keyword)]));
    setAiKeywords(merged.join(', '));
  };

  const applySavedPrompt = (): void => {
    const selected = savedPrompts.find((prompt) => prompt.id === selectedPromptId);
    if (!selected) {
      return;
    }
    setAiInstruction(selected.body);
  };

  const resetAiPanel = (): void => {
    setAiInstruction('Skriv en skarp og SEO-optimeret værdi til det valgte felt, baseret på produktdata.');
    setAiOutputLength('mellem');
    setAiKeywords('');
    setAiNegativeKeywords('');
    setAiUseWebSearch(false);
    setCompetitorLinksInput('');
    setKeywordSuggestions([]);
  };

  if (!product) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="rounded-xl border border-gray-200 bg-white p-5 h-28" />
        <div className="rounded-xl border border-gray-200 bg-white p-5 h-20" />
        <div className="rounded-xl border border-gray-200 bg-white p-5 h-64" />
        <div className="rounded-xl border border-gray-200 bg-white p-5 h-40" />
      </div>
    );
  }

  const isAdmin = userRole === 'owner' || userPlatformRole === 'platform_admin' || userPlatformRole === 'platform_support';
  // Returns true if the field is locked for the current user
  const isFieldLockedForMe = (lockLevel: 'none' | 'users' | 'all' | undefined): boolean =>
    lockLevel === 'all' || (lockLevel === 'users' && !isAdmin);

  // Renders the lock icon button (admin) or static lock indicator (non-admin)
  const renderLockIcon = (fieldId: string, lockLevel: 'none' | 'users' | 'all' | undefined): React.ReactNode => {
    const level = lockLevel ?? 'none';
    if (isAdmin) {
      return (
        <div className="relative">
          <button
            type="button"
            onClick={() => setLockPopoverId(lockPopoverId === fieldId ? null : fieldId)}
            className="text-gray-400 hover:text-gray-600 transition"
            title="Lås-indstillinger"
          >
            {level === 'none' ? (
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 opacity-30" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>
            ) : level === 'users' ? (
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-amber-500" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            ) : (
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-red-500" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            )}
          </button>
          {lockPopoverId === fieldId && (
            <div className="absolute left-0 top-full mt-1 z-50 w-56 rounded-xl border border-slate-200 bg-white shadow-xl p-1" onClick={(e) => e.stopPropagation()}>
              <button
                className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-left transition hover:bg-slate-50 ${level === 'none' ? 'font-semibold text-slate-800' : 'text-slate-600'}`}
                onClick={() => void setFieldLockLevel(fieldId, 'none')}
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 opacity-40" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>
                Ikke låst
              </button>
              <button
                className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-left transition hover:bg-slate-50 ${level === 'users' ? 'font-semibold text-slate-800' : 'text-slate-600'}`}
                onClick={() => void setFieldLockLevel(fieldId, 'users')}
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-amber-500" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                <span>Lås for brugere <span className="text-slate-400">(admins kan redigere)</span></span>
              </button>
              <button
                className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-left transition hover:bg-slate-50 ${level === 'all' ? 'font-semibold text-slate-800' : 'text-slate-600'}`}
                onClick={() => void setFieldLockLevel(fieldId, 'all')}
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-red-500" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                <span>Lås for alle <span className="text-slate-400">(inkl. admins)</span></span>
              </button>
            </div>
          )}
        </div>
      );
    }
    if (level !== 'none') {
      return <svg viewBox="0 0 24 24" className={`h-3.5 w-3.5 ${level === 'all' ? 'text-red-500' : 'text-amber-500'}`} fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>;
    }
    return null;
  };

  const shopifyAdminUrl = (() => {
    if (!product.shopifyProductGid || !product.shop?.shopUrl) return null;
    const gidParts = product.shopifyProductGid.split('/');
    const numericId = gidParts[gidParts.length - 1];
    const shopDomain = product.shop.shopUrl.replace(/^https?:\/\//, '');
    return `https://${shopDomain}/admin/products/${numericId}`;
  })();

  const firstVariant = product.variants?.[0];

  const toggleStamdata = (): void => {
    const next = !showStamdata;
    setShowStamdata(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('epim_show_stamdata', String(next));
    }
  };

  return (
    <div className={`space-y-4 ${hasUnsavedChanges || isPendingSync ? 'pb-20' : ''}`}>
      {aiResultPopup ? (
        <div className="fixed right-6 top-6 z-[70] w-[380px] animate-[fadeInUp_240ms_ease-out] rounded-2xl border border-emerald-200 bg-white p-3 shadow-2xl">
          <div className="mb-1 flex items-center justify-between">
            <div className="text-sm font-semibold text-emerald-700">AI færdig · {aiResultPopup.fieldLabel}</div>
            <button className="rounded border border-gray-300 px-2 py-0.5 text-xs" onClick={() => setAiResultPopup(null)}>Luk</button>
          </div>
          {(() => {
            const selectedField = fields.find((f) => f.id === selectedFieldId);
            const isHtmlField = selectedField?.type === 'html';
            return isHtmlField ? (
              <div
                className="ep-richtext max-h-48 overflow-auto rounded-lg border border-emerald-100 bg-emerald-50 p-2 text-xs text-slate-700"
                dangerouslySetInnerHTML={{ __html: aiResultPopup.value || '<em>Ingen værdi returneret.</em>' }}
              />
            ) : (
              <div className="max-h-48 overflow-auto rounded-lg border border-emerald-100 bg-emerald-50 p-2 text-xs text-slate-700 whitespace-pre-wrap">
                {aiResultPopup.value || 'Ingen værdi returneret.'}
              </div>
            );
          })()}
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-1 text-[11px] font-medium text-emerald-700">
              <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6 9 17l-5-5"/></svg>
              Gemt som kladde
            </span>
            <button
              className="rounded-lg bg-indigo-600 px-2 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-60 transition flex items-center justify-center gap-1"
              disabled={isSaving}
              onClick={() => { void saveAndSyncToShopify(); setAiResultPopup(null); }}
            >
              <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>
              Gem og synkronisér
            </button>
          </div>
        </div>
      ) : null}

      {/* ── AI Generation Modal ── */}
      {aiModalOpen && (
        <div className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
            onClick={() => setAiModalOpen(false)}
          />
          <div className="relative z-10 w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl bg-white shadow-2xl flex flex-col max-h-[92vh] animate-[fadeInUp_200ms_ease-out] overflow-hidden">
            {/* Launch overlay */}
            {aiLaunching && (
              <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-indigo-600 animate-[fadeIn_120ms_ease-out]">
                <div className="relative flex h-16 w-16 items-center justify-center">
                  <div className="absolute h-16 w-16 rounded-full bg-white/20 animate-ping" />
                  <div className="absolute h-10 w-10 rounded-full bg-white/10 animate-ping" style={{ animationDelay: '200ms' }} />
                  <svg viewBox="0 0 24 24" className="relative h-8 w-8 text-white" fill="currentColor">
                    <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>
                  </svg>
                </div>
                <div className="mt-5 text-base font-semibold text-white tracking-wide">Starter generering...</div>
                <div className="mt-3 flex gap-1.5">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="h-1.5 w-1.5 rounded-full bg-white/60 animate-bounce" style={{ animationDelay: `${i * 130}ms` }} />
                  ))}
                </div>
              </div>
            )}
            {/* Header */}
            <div className="flex items-center gap-3 px-5 py-4 rounded-t-2xl bg-gradient-to-r from-indigo-600 to-indigo-700 shrink-0">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/20">
                <svg viewBox="0 0 24 24" className="h-5 w-5 text-white" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/>
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-white">AI-generering</div>
                <div className="text-xs text-indigo-200 truncate font-medium">
                  {fields.find((f) => f.id === selectedFieldId)?.label ?? '—'}
                </div>
              </div>
              {activeAiJobId && (
                <span className="flex items-center gap-1.5 rounded-full bg-white/20 px-2.5 py-1 text-xs text-white shrink-0">
                  <span className="h-1.5 w-1.5 rounded-full bg-indigo-200 animate-pulse" />
                  Kører...
                </span>
              )}
              <button
                type="button"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white/70 hover:bg-white/20 hover:text-white transition"
                onClick={() => setAiModalOpen(false)}
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>

            {/* Scrollable body */}
            <div className="overflow-y-auto flex-1 px-5 py-4 space-y-5">

              {/* Quick presets */}
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-2">Hurtig-preset</div>
                <div className="flex flex-wrap gap-1.5">
                  {aiPromptPresets.map((preset) => {
                    const isActive = aiInstruction === preset.instruction;
                    return (
                      <button
                        key={preset.label}
                        type="button"
                        className={`rounded-full border px-3 py-1 text-xs font-medium active:scale-95 transition-all ${isActive ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100'}`}
                        onClick={() => setAiInstruction(preset.instruction)}
                      >
                        {preset.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Instruction */}
              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-1.5">Instruktion til AI</label>
                <textarea
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm focus:border-indigo-300 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-100 transition resize-none"
                  rows={3}
                  value={aiInstruction}
                  onChange={(e) => setAiInstruction(e.target.value)}
                />
                <div className="mt-2 flex flex-wrap gap-1">
                  {placeholderHelp.map((ph) => (
                    <button
                      key={ph}
                      type="button"
                      className="rounded border border-gray-200 bg-white px-1.5 py-0.5 font-mono text-[11px] text-gray-400 hover:bg-gray-50 hover:text-gray-600 transition"
                      onClick={() => setAiInstruction((prev) => `${prev} ${ph}`)}
                    >
                      {ph}
                    </button>
                  ))}
                </div>
              </div>

              {/* Length + toggles */}
              <div className="flex flex-wrap items-end gap-5">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-1.5">Længde</div>
                  <div className="flex rounded-xl border border-gray-200 overflow-hidden">
                    {(['fra', 'kort', 'mellem', 'lang'] as const).map((len, i) => (
                      <button
                        key={len}
                        type="button"
                        className={`px-3.5 py-2 text-xs font-medium transition ${i > 0 ? 'border-l border-gray-200' : ''} ${aiOutputLength === len ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                        onClick={() => setAiOutputLength(len)}
                      >
                        {len.charAt(0).toUpperCase() + len.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-4 pb-0.5">
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input type="checkbox" checked={aiUseHtmlOutput} onChange={(e) => setAiUseHtmlOutput(e.target.checked)} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
                    <span className="text-xs font-medium text-gray-600">Opstil/formater med HTML</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <input type="checkbox" checked={aiUseWebSearch} onChange={(e) => setAiUseWebSearch(e.target.checked)} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
                    <span className="text-xs font-medium text-gray-600">Web søgning</span>
                  </label>
                  {brandVoiceLock && (
                    <div className="group relative">
                      <span className="inline-flex cursor-help items-center gap-1 rounded-full bg-indigo-50 border border-indigo-100 px-2 py-0.5 text-xs text-indigo-600 font-medium">
                        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                        Brand voice
                      </span>
                      <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 rounded-xl bg-gray-900 px-3 py-2.5 text-xs text-gray-100 opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-50 leading-relaxed shadow-xl">
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-gray-400">Brand voice guide</div>
                        {brandVoiceGuide}
                        <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900" />
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* SEO keywords */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-1.5">SEO nøgleord</label>
                  <div className="flex gap-2">
                    <input
                      className="flex-1 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:border-indigo-300 focus:bg-white focus:outline-none transition min-w-0"
                      value={aiKeywords}
                      onChange={(e) => setAiKeywords(e.target.value)}
                      placeholder="fx led spot, GU10"
                    />
                    <button
                      type="button"
                      className="rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-60 transition whitespace-nowrap"
                      disabled={isSuggestingKeywords}
                      onClick={suggestKeywords}
                    >
                      {isSuggestingKeywords ? (
                        <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="60" strokeLinecap="round"/></svg>
                      ) : 'Find'}
                    </button>
                  </div>
                </div>
                <div>
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Negative nøgleord</span>
                    <div className="group relative">
                      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-gray-300 cursor-help hover:text-gray-400 transition" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                      <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 rounded-xl bg-gray-900 px-3 py-2.5 text-xs text-gray-100 opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-50 leading-relaxed shadow-xl">
                        Ord og fraser AI'en aktivt skal undgå i outputtet — fx prisord, konkurrentnavne eller uønskede termer.
                        <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900" />
                      </div>
                    </div>
                  </div>
                  <input
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:border-indigo-300 focus:bg-white focus:outline-none transition"
                    value={aiNegativeKeywords}
                    onChange={(e) => setAiNegativeKeywords(e.target.value)}
                    placeholder="fx gratis, billigst"
                  />
                </div>
              </div>

              {/* Keyword suggestions */}
              {keywordSuggestions.length > 0 && (
                <div className="rounded-xl border border-indigo-100 bg-gradient-to-br from-indigo-50/60 to-white p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="text-xs font-semibold text-indigo-700">Foreslåede nøgleord</div>
                    <button type="button" className="text-xs text-indigo-600 hover:text-indigo-800 font-medium" onClick={addAllKeywords}>Tilføj alle</button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {keywordSuggestions.map((s) => (
                      <button
                        key={`${s.keyword}-${s.intent}`}
                        type="button"
                        className="rounded-full border border-indigo-200 bg-white px-2 py-0.5 text-[11px] text-indigo-700 hover:bg-indigo-100 transition shadow-sm"
                        title={`${s.intent} · ${s.trafficPotential} · ${s.reason}`}
                        onClick={() => addKeyword(s.keyword)}
                      >
                        {s.keyword} · {s.trafficPotential}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Advanced (collapsible) */}
              <details className="group rounded-xl border border-gray-200 overflow-hidden">
                <summary className="cursor-pointer list-none flex items-center justify-between px-4 py-3 text-xs font-semibold uppercase tracking-widest text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition select-none">
                  <span>Avanceret</span>
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 transition-transform group-open:rotate-180" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m6 9 6 6 6-6"/></svg>
                </summary>
                <div className="border-t border-gray-100 bg-white p-4 space-y-3">
                  {reusableSources.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-xs font-medium text-gray-500">Datakilder</div>
                      <div className="space-y-1.5">
                        {reusableSources.map((source) => (
                          <label key={source.id} className="flex items-center gap-2 cursor-pointer select-none group">
                            <input
                              type="checkbox"
                              className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                              checked={selectedSourceIds.includes(source.id)}
                              onChange={(e) => {
                                setSelectedSourceIds((prev) =>
                                  e.target.checked ? [...prev, source.id] : prev.filter((id) => id !== source.id)
                                );
                                if (!e.target.checked) setSourcesOnly(false);
                              }}
                            />
                            <span className="text-xs text-gray-700 group-hover:text-gray-900 transition">{source.name}</span>
                            <span className="text-[10px] text-gray-400">{source.type === 'product_feed' ? 'Produktfeed' : source.type === 'products' ? 'Produkter' : 'Web'}</span>
                          </label>
                        ))}
                      </div>
                      {selectedSourceIds.length > 0 && (
                        <label className="flex items-center gap-2 cursor-pointer select-none mt-2 pt-2 border-t border-gray-100">
                          <input
                            type="checkbox"
                            className="rounded border-gray-300 text-amber-600 focus:ring-amber-500"
                            checked={sourcesOnly}
                            onChange={(e) => setSourcesOnly(e.target.checked)}
                          />
                          <span className="text-xs font-medium text-gray-700">Brug <em>udelukkende</em> kildedata</span>
                          <div className="group relative">
                            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-gray-300 cursor-help hover:text-gray-400 transition" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                            <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-60 rounded-xl bg-gray-900 px-3 py-2.5 text-xs text-gray-100 opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-50 leading-relaxed shadow-xl">
                              AI'en må kun bruge information fra de valgte kilder — ingen ekstra viden eller antagelser tilføjes.
                              <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900" />
                            </div>
                          </div>
                        </label>
                      )}
                    </div>
                  )}
                  {savedPrompts.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-gray-100">
                      <div className="text-xs font-medium text-gray-500 w-full">Gemte prompts</div>
                      <select
                        className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm"
                        value={selectedPromptId}
                        onChange={(e) => setSelectedPromptId(e.target.value)}
                      >
                        {savedPrompts.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                      <button type="button" className="rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs hover:bg-gray-50 transition" onClick={applySavedPrompt}>Indsæt</button>
                    </div>
                  )}
                  <details className="text-xs">
                    <summary className="cursor-pointer text-gray-400 hover:text-gray-600 select-none">Vis prompt</summary>
                    <textarea className="mt-1.5 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs" rows={5} readOnly value={aiPrompt} />
                  </details>
                </div>
              </details>
            </div>

            {/* Footer */}
            <div className="flex items-center gap-3 border-t border-gray-100 px-5 py-4 shrink-0">
              <button
                type="button"
                className="rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-600 hover:bg-gray-50 transition font-medium"
                onClick={resetAiPanel}
              >
                Nulstil
              </button>
              <button
                type="button"
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 active:scale-[0.98] disabled:opacity-60 transition-all"
                disabled={isGeneratingAi || aiLaunching}
                onClick={() => {
                  setAiLaunching(true);
                  setTimeout(() => {
                    setAiLaunching(false);
                    setAiModalOpen(false);
                    void runAiForSelectedField();
                  }, 700);
                }}
              >
                {isGeneratingAi ? (
                  <>
                    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="60" strokeLinecap="round"/></svg>
                    Genererer...
                  </>
                ) : (
                  <>
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
                    Generér med AI
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Product header ── */}
      <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
        {/* Top: title + image */}
        <div className="flex gap-4 p-4 md:p-5">
          <div className="flex-1 min-w-0">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <h1 className="text-2xl font-bold text-gray-900 leading-tight">{product.title}</h1>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {(() => {
                    const statusColors: Record<string, string> = {
                      ACTIVE: 'bg-emerald-100 text-emerald-800 border-emerald-200',
                      DRAFT: 'bg-amber-100 text-amber-800 border-amber-200',
                      ARCHIVED: 'bg-gray-100 text-gray-600 border-gray-200',
                    };
                    return (
                      <select
                        className={`w-fit shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold cursor-pointer focus:outline-none ${statusColors[statusEdit] ?? 'bg-gray-100 text-gray-600 border-gray-200'}`}
                        value={statusEdit}
                        onChange={(e) => setStatusEdit(e.target.value)}
                      >
                        <option value="ACTIVE">Aktiv</option>
                        <option value="DRAFT">Kladde</option>
                        <option value="ARCHIVED">Arkiveret</option>
                      </select>
                    );
                  })()}
                  {product.productType && (
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-[11px] font-medium text-slate-600">{product.productType}</span>
                  )}
                  {shopifyAdminUrl && (
                    <a
                      href={shopifyAdminUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100 hover:border-emerald-300 transition"
                    >
                      <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/></svg>
                      Se i Shopify
                    </a>
                  )}
                  {product.shop?.shopUrl && product.handle && (
                    <a
                      href={`https://${product.shop.shopUrl.replace(/^https?:\/\//, '')}/products/${product.handle}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-[11px] font-semibold text-indigo-700 hover:bg-indigo-100 hover:border-indigo-300 transition"
                    >
                      <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/></svg>
                      Se på webshop
                    </a>
                  )}
                </div>
              </div>
            </div>
          </div>
          {/* Images */}
          <div className="shrink-0 flex flex-col gap-2 items-end">
            <div className="flex flex-wrap gap-1.5 justify-end max-w-[220px]">
              {imageEdits.map((img, idx) => (
                <div
                  key={idx}
                  className={`relative group cursor-grab active:cursor-grabbing ${lightboxDragIndex === idx ? 'opacity-40' : ''}`}
                  draggable
                  onDragStart={() => setLightboxDragIndex(idx)}
                  onDragOver={(e) => { e.preventDefault(); }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (lightboxDragIndex === null || lightboxDragIndex === idx) return;
                    setImageEdits((prev) => {
                      const next = [...prev];
                      const [moved] = next.splice(lightboxDragIndex, 1);
                      next.splice(idx, 0, moved);
                      return next;
                    });
                    setLightboxDragIndex(null);
                  }}
                  onDragEnd={() => setLightboxDragIndex(null)}
                >
                  <img
                    src={img.url}
                    alt={img.altText ?? `Billede ${idx + 1}`}
                    onClick={() => setLightboxIndex(idx)}
                    className={`rounded-lg border border-gray-200 object-cover cursor-pointer transition hover:opacity-90 ${idx === 0 ? 'h-24 w-24' : 'h-10 w-10 opacity-80 hover:opacity-100'}`}
                  />
                  <button
                    onClick={(e) => { e.stopPropagation(); setImageEdits((prev) => prev.filter((_, i) => i !== idx)); }}
                    className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center opacity-0 group-hover:opacity-100 transition shadow"
                    title="Fjern billede"
                  >
                    ✕
                  </button>
                </div>
              ))}
              {/* Add image button */}
              <div className="relative">
                <button
                  onClick={() => setAddImagePopoverOpen((prev) => !prev)}
                  className="h-10 w-10 rounded-lg border border-dashed border-gray-300 bg-gray-50 text-gray-400 hover:border-indigo-300 hover:text-indigo-500 hover:bg-indigo-50 transition flex items-center justify-center text-lg leading-none"
                  title="Tilføj billede"
                >
                  +
                </button>
                {addImagePopoverOpen && (
                  <div className="absolute right-0 top-12 z-20 w-64 rounded-xl border border-gray-200 bg-white p-3 shadow-xl">
                    <p className="text-[11px] font-semibold text-gray-600 mb-1.5">Indsæt billed-URL</p>
                    <input
                      autoFocus
                      type="url"
                      placeholder="https://..."
                      className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-xs focus:border-indigo-300 focus:outline-none"
                      value={addImageUrl}
                      onChange={(e) => setAddImageUrl(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && addImageUrl.trim()) {
                          setImageEdits((prev) => [...prev, { url: addImageUrl.trim() }]);
                          setAddImageUrl('');
                          setAddImagePopoverOpen(false);
                        }
                        if (e.key === 'Escape') setAddImagePopoverOpen(false);
                      }}
                    />
                    <div className="flex gap-1.5 mt-2">
                      <button
                        onClick={() => {
                          if (!addImageUrl.trim()) return;
                          setImageEdits((prev) => [...prev, { url: addImageUrl.trim() }]);
                          setAddImageUrl('');
                          setAddImagePopoverOpen(false);
                        }}
                        className="flex-1 rounded-lg bg-indigo-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-indigo-700 transition"
                      >
                        Tilføj
                      </button>
                      <button
                        onClick={() => { setAddImagePopoverOpen(false); setAddImageUrl(''); }}
                        className="rounded-lg border border-gray-200 px-2 py-1 text-[11px] text-gray-500 hover:bg-gray-50 transition"
                      >
                        Annuller
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Tab navigation ── */}
      <div className="flex gap-0.5 rounded-xl border border-slate-200 bg-slate-50 p-1 w-fit">
        {([
          { id: 'indhold', label: 'Indhold' },
          { id: 'varianter', label: 'Varianter' },
          { id: 'oversaettelser', label: 'Oversættelser' },
          { id: 'historik', label: 'Historik' },
        ] as const).map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-all ${
              activeTab === tab.id
                ? 'bg-white shadow-sm text-slate-800'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'indhold' && (
      <>

      {/* ── Stamdata + Felter side-by-side ── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">

      {/* ── Stamdata ── */}
      <div className="rounded-xl border border-gray-200 bg-white">
        <button
          onClick={toggleStamdata}
          className="flex w-full items-center justify-between p-4 text-left md:px-5"
        >
          <span className="text-sm font-semibold text-gray-900">Stamdata</span>
          <svg viewBox="0 0 24 24" className={`h-4 w-4 text-gray-400 transition-transform ${showStamdata ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        {showStamdata && (
          <div className="border-t border-gray-100 px-4 pb-5 pt-4 md:px-5 space-y-5">

            {/* Titel */}
            {(() => {
              const f = fields.find((field) => field.key === '_title');
              if (!f) return null;
              return (
                <div className="text-sm">
                  <div className="flex items-center justify-between mb-1.5">
                    <label htmlFor={`stamdata-field-${f.id}`} className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">
                      {f.label}
                      {renderLockIcon(f.id, f.lockLevel)}
                      {fieldMappingDetails.has(f.id) && (() => {
                        const mapping = fieldMappingDetails.get(f.id)!;
                        return (
                          <span className="group relative ml-1.5 inline-flex">
                            <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 cursor-help">
                              <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                              Shopify
                            </span>
                            <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 w-48 rounded-xl bg-gray-900 px-3 py-2 text-xs text-gray-100 opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-50 leading-relaxed shadow-xl whitespace-nowrap">
                              <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-0.5">Mappet til Shopify</div>
                              {mapping.targetType || 'Shopify-felt'}
                              <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900" />
                            </div>
                          </span>
                        );
                      })()}
                    </label>
                    <button
                      type="button"
                      className="flex items-center gap-1 rounded border border-indigo-200 bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-100 transition"
                      onClick={() => openAiModalForField(f.id)}
                    >
                      <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
                      Generér
                    </button>
                  </div>
                  <input
                    id={`stamdata-field-${f.id}`}
                    className={`w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700 focus:border-indigo-300 focus:bg-white focus:outline-none transition ${isFieldLockedForMe(f.lockLevel) ? 'cursor-not-allowed opacity-60' : ''}`}
                    value={fieldEdits[f.id] ?? ''}
                    onChange={(e) => setFieldEdits((prev) => ({ ...prev, [f.id]: e.target.value }))}
                    disabled={isFieldLockedForMe(f.lockLevel)}
                  />
                </div>
              );
            })()}

            {/* Beskrivelse */}
            {(() => {
              const f = fields.find((field) => field.key === '_description');
              if (!f) return null;
              const mode = htmlEditorMode[f.id] ?? 'visual';
              return (
                <div className="text-sm">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">
                      {f.label}
                      {renderLockIcon(f.id, f.lockLevel)}
                      {fieldMappingDetails.has(f.id) && (() => {
                        const mapping = fieldMappingDetails.get(f.id)!;
                        return (
                          <span className="group relative ml-1.5 inline-flex">
                            <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 cursor-help">
                              <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                              Shopify
                            </span>
                            <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 w-48 rounded-xl bg-gray-900 px-3 py-2 text-xs text-gray-100 opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-50 leading-relaxed shadow-xl whitespace-nowrap">
                              <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-0.5">Mappet til Shopify</div>
                              {mapping.targetType || 'Shopify-felt'}
                              <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900" />
                            </div>
                          </span>
                        );
                      })()}
                    </span>
                  </div>
                  <div className={`rounded-lg border border-gray-300 bg-white ${isFieldLockedForMe(f.lockLevel) ? 'opacity-60' : ''}`}>
                    <div className="flex flex-wrap items-center gap-1 border-b border-gray-200 p-2">
                      <button type="button" className={`rounded border px-2 py-1 text-xs ${mode === 'visual' ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-gray-300'}`} onClick={() => setHtmlEditorMode((prev) => ({ ...prev, [f.id]: 'visual' }))}>Visuel</button>
                      <button type="button" className={`rounded border px-2 py-1 text-xs ${mode === 'source' ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-gray-300'}`} onClick={() => setHtmlEditorMode((prev) => ({ ...prev, [f.id]: 'source' }))}>Kildekode</button>
                      <button type="button" className="rounded border border-gray-300 px-2 py-1 text-xs" onClick={() => execEditorCommand('bold')}>Fed</button>
                      <button type="button" className="rounded border border-gray-300 px-2 py-1 text-xs" onClick={() => execEditorCommand('italic')}>Kursiv</button>
                      <button type="button" className="rounded border border-gray-300 px-2 py-1 text-xs" onClick={() => execEditorCommand('insertUnorderedList')}>Liste</button>
                      <button type="button" className="rounded border border-gray-300 px-2 py-1 text-xs" onClick={insertEditorLink}>Link</button>
                      <button type="button" className="rounded border border-gray-300 px-2 py-1 text-xs" onClick={() => execEditorCommand('removeFormat')}>Ryd format</button>
                      <button
                        type="button"
                        className="ml-auto flex items-center gap-1 rounded border border-indigo-200 bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-100 active:scale-95 transition-all shrink-0"
                        onClick={() => openAiModalForField(f.id)}
                      >
                        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
                        Generér
                      </button>
                    </div>
                    {mode === 'source' ? (
                      <textarea
                        className={`h-64 w-full resize-none border-0 p-3 font-mono text-xs overflow-y-auto ${isFieldLockedForMe(f.lockLevel) ? 'bg-gray-50 cursor-not-allowed' : ''}`}
                        value={fieldEdits[f.id] ?? ''}
                        onChange={(event) => setFieldEdits((prev) => ({ ...prev, [f.id]: event.target.value }))}
                        disabled={isFieldLockedForMe(f.lockLevel)}
                      />
                    ) : (
                      <div
                        ref={(el) => {
                          htmlEditorRefs.current[f.id] = el;
                          if (el && htmlEditorDomValueRef.current[f.id] === undefined) {
                            el.innerHTML = fieldEdits[f.id] ?? '';
                            htmlEditorDomValueRef.current[f.id] = fieldEdits[f.id] ?? '';
                          }
                        }}
                        className={`ep-richtext h-64 overflow-y-auto p-3 outline-none ${isFieldLockedForMe(f.lockLevel) ? 'bg-gray-50 cursor-not-allowed' : ''}`}
                        contentEditable={!isFieldLockedForMe(f.lockLevel)}
                        suppressContentEditableWarning
                        onInput={(event) => {
                          const html = event.currentTarget.innerHTML;
                          htmlEditorDomValueRef.current[f.id] = html;
                          setFieldEdits((prev) => ({ ...prev, [f.id]: html }));
                        }}
                      />
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Row 1: Handle + Vendor + Type */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label htmlFor="handle-edit" className="block text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1.5">Handle</label>
                <input
                  id="handle-edit"
                  className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-mono text-gray-700 focus:border-indigo-300 focus:bg-white focus:outline-none transition"
                  value={handleEdit}
                  onChange={(e) => setHandleEdit(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1.5">Vendor</label>
                <input
                  className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700 focus:border-indigo-300 focus:bg-white focus:outline-none transition"
                  value={vendorEdit}
                  onChange={(e) => setVendorEdit(e.target.value)}
                  placeholder="fx Acme Corp"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1.5">Produkttype</label>
                <input
                  className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700 focus:border-indigo-300 focus:bg-white focus:outline-none transition"
                  value={productTypeEdit}
                  onChange={(e) => setProductTypeEdit(e.target.value)}
                  placeholder="fx Elektronik"
                />
              </div>
            </div>

            {/* Row 2: Tags */}
            <div>
              <label htmlFor="tags-edit" className="block text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1.5">Tags</label>
              <input
                id="tags-edit"
                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:border-indigo-300 focus:bg-white focus:outline-none transition"
                placeholder="kommasepareret, fx sommer, tilbud"
                value={tagsInput}
                onChange={(event) => setTagsInput(event.target.value)}
              />
              {tagsInput.split(',').map((t) => t.trim()).filter(Boolean).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {tagsInput.split(',').map((tag) => tag.trim()).filter(Boolean).map((tag) => (
                    <span key={tag} className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-medium text-slate-600">{tag}</span>
                  ))}
                </div>
              )}
            </div>

            {/* Row 3: Published channels + Storefront */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1.5">Publiceringskanaler</div>
                {!product.shopifyProductGid ? (
                  <div className="text-sm text-gray-400 italic">Produktet er ikke synkroniseret med Shopify endnu</div>
                ) : publicationsLoading ? (
                  <div className="flex items-center gap-1.5 text-xs text-gray-400">
                    <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                    Henter kanaler...
                  </div>
                ) : publications.length === 0 ? (
                  <div className="text-sm text-gray-400 italic">Ingen publiceringskanaler tilgængelige</div>
                ) : (
                  <div className="space-y-1.5">
                    {publications.map((pub) => (
                      <label key={pub.id} className="flex items-center gap-2 cursor-pointer select-none group">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
                          checked={pub.isPublished}
                          onChange={async (e) => {
                            const publish = e.target.checked;
                            setPublications((prev) => prev.map((p) => p.id === pub.id ? { ...p, isPublished: publish } : p));
                            try {
                              await apiFetch(`/products/${product.id}/publications`, {
                                method: 'PUT',
                                body: JSON.stringify({ publicationId: pub.id, publish }),
                              });
                            } catch {
                              setPublications((prev) => prev.map((p) => p.id === pub.id ? { ...p, isPublished: !publish } : p));
                              setMessage('Kunne ikke opdatere publiceringskanal.');
                            }
                          }}
                        />
                        <span className={`text-sm font-medium transition ${pub.isPublished ? 'text-gray-800' : 'text-gray-400'}`}>{pub.name}</span>
                        {pub.isPublished ? (
                          <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">Publiceret</span>
                        ) : (
                          <span className="inline-flex items-center gap-0.5 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">Ikke publiceret</span>
                        )}
                      </label>
                    ))}
                  </div>
                )}
              </div>
              {product.shop?.shopUrl && (
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1.5">Butikslink</div>
                  <a
                    href={`https://${product.shop.shopUrl}/products/${product.handle}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-mono text-indigo-600 hover:text-indigo-800 hover:underline truncate max-w-full"
                  >
                    {`${product.shop.shopUrl}/products/${product.handle}`}
                    <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/></svg>
                  </a>
                </div>
              )}
            </div>

          </div>
        )}
      </div>


      <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
        <button
          onClick={() => setFelterOpen((v) => !v)}
          className="flex w-full items-center justify-between p-4 text-left md:px-5"
        >
          <span className="text-sm font-semibold text-gray-900">Felter</span>
          <svg viewBox="0 0 24 24" className={`h-4 w-4 text-gray-400 transition-transform ${felterOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        {felterOpen && (
        <div className="border-t border-gray-100 px-4 pb-5 pt-4 md:px-5 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {fields.filter((field) => field.key !== '_title' && field.key !== '_description').map((field) => {
            if (field.type === 'html') {
              const mode = htmlEditorMode[field.id] ?? 'visual';
              return (
                <div key={field.id} className="text-sm md:col-span-2">
                  <span className="font-medium text-gray-700 flex items-center gap-1.5">
                    {field.label}
                    {renderLockIcon(field.id, field.lockLevel)}
                    {fieldMappingDetails.has(field.id) && (() => {
                      const mapping = fieldMappingDetails.get(field.id)!;
                      const targetLabel = mapping.targetType || 'Shopify-felt';
                      return (
                        <span className="group relative ml-1.5 inline-flex">
                          <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 cursor-help">
                            <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                            Shopify
                          </span>
                          <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 w-48 rounded-xl bg-gray-900 px-3 py-2 text-xs text-gray-100 opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-50 leading-relaxed shadow-xl whitespace-nowrap">
                            <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-0.5">Mappet til Shopify</div>
                            {targetLabel}
                            <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900" />
                          </div>
                        </span>
                      );
                    })()}
                  </span>
                  <div className="mt-1 rounded-lg border border-gray-300 bg-white">
                    <div className="flex flex-wrap items-center gap-1 border-b border-gray-200 p-2">
                      <button
                        type="button"
                        className={`rounded border px-2 py-1 text-xs ${mode === 'visual' ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-gray-300'}`}
                        onClick={() => setHtmlEditorMode((prev) => ({ ...prev, [field.id]: 'visual' }))}
                      >
                        Visuel
                      </button>
                      <button
                        type="button"
                        className={`rounded border px-2 py-1 text-xs ${mode === 'source' ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-gray-300'}`}
                        onClick={() => setHtmlEditorMode((prev) => ({ ...prev, [field.id]: 'source' }))}
                      >
                        Kildekode
                      </button>
                      <button type="button" className="rounded border border-gray-300 px-2 py-1 text-xs" onClick={() => execEditorCommand('bold')}>Fed</button>
                      <button type="button" className="rounded border border-gray-300 px-2 py-1 text-xs" onClick={() => execEditorCommand('italic')}>Kursiv</button>
                      <button type="button" className="rounded border border-gray-300 px-2 py-1 text-xs" onClick={() => execEditorCommand('insertUnorderedList')}>Liste</button>
                      <button type="button" className="rounded border border-gray-300 px-2 py-1 text-xs" onClick={insertEditorLink}>Link</button>
                      <button type="button" className="rounded border border-gray-300 px-2 py-1 text-xs" onClick={() => execEditorCommand('removeFormat')}>Ryd format</button>
                      <button
                        type="button"
                        className="ml-auto flex items-center gap-1 rounded border border-indigo-200 bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-100 active:scale-95 transition-all shrink-0"
                        onClick={() => openAiModalForField(field.id)}
                      >
                        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
                        Generér
                      </button>
                    </div>
                    {mode === 'source' ? (
                      <textarea
                        className={`h-64 w-full resize-none border-0 p-3 font-mono text-xs overflow-y-auto ${isFieldLockedForMe(field.lockLevel) ? 'bg-gray-50 cursor-not-allowed' : ''}`}
                        value={fieldEdits[field.id] ?? ''}
                        disabled={isFieldLockedForMe(field.lockLevel)}
                        onChange={(event) =>
                          setFieldEdits((prev) => ({
                            ...prev,
                            [field.id]: event.target.value,
                          }))
                        }
                      />
                    ) : (
                      <div
                        ref={(el) => {
                          htmlEditorRefs.current[field.id] = el;
                          if (el && htmlEditorDomValueRef.current[field.id] === undefined) {
                            // First mount: set initial content
                            el.innerHTML = fieldEdits[field.id] ?? '';
                            htmlEditorDomValueRef.current[field.id] = fieldEdits[field.id] ?? '';
                          }
                        }}
                        className={`ep-richtext h-64 overflow-y-auto p-3 outline-none ${isFieldLockedForMe(field.lockLevel) ? 'bg-gray-50 cursor-not-allowed' : ''}`}
                        contentEditable={!isFieldLockedForMe(field.lockLevel)}
                        suppressContentEditableWarning
                        onInput={(event) => {
                          const html = event.currentTarget.innerHTML;
                          // Record what the DOM shows so the sync useEffect can skip this change
                          htmlEditorDomValueRef.current[field.id] = html;
                          setFieldEdits((prev) => ({ ...prev, [field.id]: html }));
                        }}
                      />
                    )}
                  </div>
                </div>
              );
            }

            return (
              <div key={field.id} className="text-sm">
                <label htmlFor={`field-${field.id}`} className="font-medium text-gray-700 cursor-pointer flex items-center gap-1.5">
                  {field.label}
                  {field.isBuiltIn && <span className="inline-flex items-center rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700">Systemfelt</span>}
                  {renderLockIcon(field.id, field.lockLevel)}
                  {fieldMappingDetails.has(field.id) && (() => {
                    const mapping = fieldMappingDetails.get(field.id)!;
                    const targetLabel = mapping.targetType || 'Shopify-felt';
                    return (
                      <span className="group relative ml-1.5 inline-flex">
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 cursor-help">
                          <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                          Shopify
                        </span>
                        <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 w-48 rounded-xl bg-gray-900 px-3 py-2 text-xs text-gray-100 opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-50 leading-relaxed shadow-xl whitespace-nowrap">
                          <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-0.5">Mappet til Shopify</div>
                          {targetLabel}
                          <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900" />
                        </div>
                      </span>
                    );
                  })()}
                </label>
                <div className="relative mt-1">
                  <input
                    id={`field-${field.id}`}
                    className={`w-full rounded-lg border px-3 py-2 pr-[104px] transition ${
                      isFieldLockedForMe(field.lockLevel)
                        ? 'border-gray-200 bg-gray-50 cursor-not-allowed text-gray-500'
                        : (fieldEdits[field.id] ?? '') === ''
                          ? 'border-dashed border-gray-200 bg-gray-50/50 text-gray-400 placeholder-gray-300'
                          : 'border-gray-300 bg-white'
                    }`}
                    value={fieldEdits[field.id] ?? ''}
                    placeholder="Tom — klik for at redigere"
                    disabled={isFieldLockedForMe(field.lockLevel)}
                    onChange={(event) =>
                      setFieldEdits((prev) => ({
                        ...prev,
                        [field.id]: event.target.value,
                      }))
                    }
                  />
                  <button
                    type="button"
                    title={`Generér "${field.label}" med AI`}
                    className="absolute inset-y-1 right-1 flex items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-2 text-xs font-medium text-indigo-600 hover:bg-indigo-100 hover:text-indigo-700 active:scale-95 transition-all"
                    onClick={() => openAiModalForField(field.id)}
                  >
                    <svg viewBox="0 0 24 24" className="h-3 w-3 shrink-0" fill="none" stroke="currentColor" strokeWidth="2"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
                    Generér
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm font-medium text-sky-700 hover:bg-sky-100 disabled:opacity-60 transition flex items-center gap-1.5"
            disabled={isSaving}
            onClick={pullFromShopify}
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M19 12H5" /><path d="m11 6-6 6 6 6" />
            </svg>
            Hent fra Shopify
          </button>
          <button
            className="rounded-lg border border-indigo-200 bg-white px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-60 transition"
            disabled={isSaving}
            onClick={saveFieldValues}
          >
            {isSaving ? 'Gemmer...' : 'Gem kladde'}
          </button>
          <button
            className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60 transition flex items-center gap-1.5"
            disabled={isSaving || (!hasUnsavedChanges && !hasDraft && !isPendingSync)}
            onClick={saveAndSyncToShopify}
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M5 12h14" /><path d="m13 6 6 6-6 6" />
            </svg>
            {isSaving ? 'Gemmer...' : 'Gem og synkronisér til Shopify'}
          </button>
          {draftSaveStatus === 'saving' && (
            <span className="inline-flex items-center gap-1 text-xs text-slate-500">
              <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
              Auto-gemmer kladde…
            </span>
          )}
          {draftSaveStatus === 'saved' && (
            <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
              <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 6 9 17l-5-5"/></svg>
              Kladde gemt
            </span>
          )}
          {product.lastShopifySyncAt ? (
            <span className="text-xs text-slate-500">
              Sidst synkroniseret: {new Date(product.lastShopifySyncAt).toLocaleString('da-DK', { dateStyle: 'short', timeStyle: 'short' })}
              {(() => {
                const lastSync = new Date(product.lastShopifySyncAt).getTime();
                const localChanged = product.updatedAt ? new Date(product.updatedAt).getTime() > lastSync + 1000 : false;
                const shopifyChanged = product.shopifyUpdatedAt ? new Date(product.shopifyUpdatedAt).getTime() > lastSync + 1000 : false;
                if (localChanged && shopifyChanged) {
                  return (
                    <a href="#conflict-banner" className="ml-2 inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-700 hover:bg-red-200 transition cursor-pointer">
                      <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
                      Konflikt — se løsning ↓
                    </a>
                  );
                }
                if (localChanged) {
                  return (
                    <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-medium text-orange-700">
                      <span className="h-1.5 w-1.5 rounded-full bg-orange-500" />
                      Afventer Shopify
                    </span>
                  );
                }
                return (
                  <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    Synkroniseret
                  </span>
                );
              })()}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
              Aldrig synkroniseret til Shopify
            </span>
          )}
        </div>
        </div>
        )}
      </div>
      </div>{/* end xl:grid-cols-2 */}

      {/* Conflict resolution panel */}
      {isConflict && (
        <div id="conflict-banner" className="rounded-xl border-2 border-red-200 bg-white shadow-sm overflow-hidden">
          {/* Header */}
          <div className="flex items-start gap-3 bg-red-50 px-5 py-4 border-b border-red-100">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-100">
              <svg viewBox="0 0 24 24" className="h-4.5 w-4.5 text-red-600" style={{width:'18px',height:'18px'}} fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
                <path d="M12 9v4"/><path d="M12 17h.01"/>
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-red-900 text-[15px]">Synkroniseringskonflikt</div>
              <div className="mt-1 text-sm text-red-700 leading-relaxed">
                Både ePIM og Shopify har fået ændringer siden sidste synkronisering. Du skal vælge hvilken version der skal gælde — ellers risikerer du at overskrive ændringer.
              </div>
            </div>
          </div>

          {/* Timeline: tre tidsstempler */}
          <div className="grid grid-cols-3 divide-x divide-slate-100 text-xs">
            <div className="px-4 py-3 bg-slate-50">
              <div className="font-medium text-slate-400 uppercase tracking-wide text-[10px] mb-1">Sidst synkroniseret</div>
              <div className="font-semibold text-slate-600">{product.lastShopifySyncAt ? formatRelativeConflict(product.lastShopifySyncAt) : '—'}</div>
              {product.lastShopifySyncAt && (
                <div className="text-slate-400 mt-0.5">{new Date(product.lastShopifySyncAt).toLocaleString('da-DK', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
              )}
            </div>
            <div className="px-4 py-3 bg-indigo-50/60">
              <div className="font-medium text-indigo-400 uppercase tracking-wide text-[10px] mb-1">ePIM redigeret</div>
              <div className="font-semibold text-indigo-700">{product.updatedAt ? formatRelativeConflict(product.updatedAt) : '—'}</div>
              {product.updatedAt && (
                <div className="text-indigo-400 mt-0.5">{new Date(product.updatedAt).toLocaleString('da-DK', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
              )}
            </div>
            <div className="px-4 py-3 bg-orange-50/60">
              <div className="font-medium text-orange-400 uppercase tracking-wide text-[10px] mb-1">Shopify opdateret</div>
              <div className="font-semibold text-orange-700">{product.shopifyUpdatedAt ? formatRelativeConflict(product.shopifyUpdatedAt) : '—'}</div>
              {product.shopifyUpdatedAt && (
                <div className="text-orange-400 mt-0.5">{new Date(product.shopifyUpdatedAt).toLocaleString('da-DK', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
              )}
            </div>
          </div>

          {/* Diff comparison (loaded on demand) */}
          {shopifyConflictData && (() => {
            const rows = buildConflictDiffRows(product, shopifyConflictData);
            const changedRows = rows.filter((r) => r.differs);
            return (
              <div className="border-t border-slate-100">
                <div className="px-5 pt-4 pb-2 flex items-center justify-between">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Sammenligning af stamdata
                    {changedRows.length === 0 && <span className="ml-2 font-normal text-emerald-600 normal-case tracking-normal">— ingen forskel fundet i stamdata</span>}
                  </div>
                  {changedRows.length > 0 && (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">{changedRows.length} felt{changedRows.length !== 1 ? 'er' : ''} forskellig{changedRows.length !== 1 ? 'e' : ''}</span>
                  )}
                </div>
                <div className="mx-5 mb-4 rounded-lg border border-slate-200 overflow-hidden">
                  {/* Column headers */}
                  <div className="grid grid-cols-[120px_1fr_1fr] bg-slate-50 border-b border-slate-200 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    <div className="px-3 py-2">Felt</div>
                    <div className="px-3 py-2 border-l border-slate-200 flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-indigo-400 shrink-0" />ePIM
                    </div>
                    <div className="px-3 py-2 border-l border-slate-200 flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full bg-orange-400 shrink-0" />Shopify
                    </div>
                  </div>
                  {rows.map((row) => (
                    <div key={row.field} className={`grid grid-cols-[120px_1fr_1fr] text-sm border-b border-slate-100 last:border-0 ${row.differs ? 'bg-amber-50/40' : ''}`}>
                      <div className="px-3 py-2.5 text-[11px] font-medium text-slate-500 self-start pt-3">{row.label}</div>
                      <div className={`px-3 py-2.5 border-l border-slate-100 break-words ${row.differs ? 'text-indigo-900 font-medium' : 'text-slate-400'}`}>
                        {row.epimValue ? <span className="line-clamp-3">{row.epimValue}</span> : <span className="italic text-slate-300">tom</span>}
                      </div>
                      <div className={`px-3 py-2.5 border-l border-slate-100 break-words ${row.differs ? 'text-orange-900 font-medium' : 'text-slate-400'}`}>
                        {row.shopifyValue ? <span className="line-clamp-3">{row.shopifyValue}</span> : <span className="italic text-slate-300">tom</span>}
                        {row.differs && <span className="ml-1.5 inline-block rounded bg-amber-100 px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-700">Forskel</span>}
                      </div>
                    </div>
                  ))}
                </div>
                {changedRows.length === 0 && (
                  <p className="px-5 pb-4 text-xs text-slate-500">Konflikten skyldes sandsynligvis ændringer i custom-felter eller metadata, ikke stamdata.</p>
                )}
              </div>
            );
          })()}

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-3 px-5 py-4 border-t border-slate-100 bg-slate-50/50">
            {!shopifyConflictData && (
              <button
                className="text-sm text-indigo-600 hover:text-indigo-800 underline underline-offset-2 disabled:opacity-50 transition"
                disabled={isFetchingDiff || isSaving}
                onClick={() => void fetchConflictDiff()}
              >
                {isFetchingDiff
                  ? <span className="flex items-center gap-1.5"><svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>Henter forskel…</span>
                  : 'Vis hvad der er forskelligt →'}
              </button>
            )}
            {shopifyConflictData && (
              <button
                className="text-sm text-slate-400 hover:text-slate-600 underline underline-offset-2 transition"
                onClick={() => setShopifyConflictData(null)}
              >
                Skjul sammenligning
              </button>
            )}
            <div className="flex items-center gap-2.5 ml-auto">
              <button
                className="rounded-lg border border-orange-200 bg-white px-4 py-2 text-sm font-medium text-orange-800 hover:bg-orange-50 disabled:opacity-50 transition"
                disabled={isSaving}
                onClick={() => void acceptShopifyData()}
                title="Henter de nyeste data fra Shopify og overskriver ePIM's version"
              >
                <span className="flex items-center gap-1.5">
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  Hent fra Shopify
                </span>
              </button>
              <button
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 transition"
                disabled={isSaving}
                onClick={() => void saveAndSyncToShopify()}
                title="Gemmer ePIM's version og sender den til Shopify — overskriver Shopifys ændringer"
              >
                <span className="flex items-center gap-1.5">
                  {isSaving ? 'Synkroniserer…' : 'Brug ePIM-version → sync til Shopify'}
                  {!isSaving && <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}


      {message ? <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700">{message}</div> : null}

      {warnings.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 md:p-5 space-y-2">
          <div className="flex items-center gap-2 mb-1">
            <svg viewBox="0 0 24 24" className="h-4 w-4 text-amber-600 shrink-0" fill="none" stroke="currentColor" strokeWidth="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
            <span className="text-sm font-semibold text-amber-800">{warnings.length} {warnings.length !== 1 ? 'advarsler' : 'advarsel'}</span>
          </div>
          {warnings.map((warning, index) => {
            const fieldLabel = warning.fieldDefinitionId
              ? (fields.find((f) => f.id === warning.fieldDefinitionId)?.label ?? null)
              : null;

            let typeLabel: string;
            let msgLabel: React.ReactNode;

            if (warning.type === 'mapping') {
              typeLabel = 'Ingen mapping';
              msgLabel = 'Feltet er ikke mappet til et Shopify-felt og vil ikke blive synkroniseret.';
            } else if (warning.type === 'conflict' && warning.message.includes('Two-way conflict within configured conflict window')) {
              typeLabel = 'Manuel konflikt';
              msgLabel = (
                <>
                  Feltet er sat til tovejs-synk med <strong>manuel konfliktpolitik</strong>, og begge systemer har nylige ændringer.
                  {' '}Synkroniseringen er sat på pause.{' '}
                  <a href="/settings/mappings" className="underline hover:text-amber-900">
                    Gå til Mappings → skift konfliktpolitik
                  </a>{' '}
                  til <em>Nyeste vinder</em> eller <em>ePIM vinder</em> for at tillade automatisk synkronisering.
                </>
              );
            } else if (warning.type === 'conflict') {
              typeLabel = 'Synkroniseringskonflikt';
              msgLabel = warning.message === 'Two-way conflict'
                ? 'Tovejs-konflikt registreret. Begge systemer har ændringer — tag stilling i mappings-indstillingerne.'
                : warning.message;
            } else {
              typeLabel = warning.type;
              msgLabel = warning.message;
            }

            return (
              <div key={`${warning.type}-${warning.message}-${index}`} className="flex items-start gap-2 text-sm text-amber-800">
                <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" />
                <span>
                  {fieldLabel && <span className="font-semibold">{fieldLabel} — </span>}
                  <span className="font-medium">{typeLabel}:</span>{' '}
                  {msgLabel}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Live vs. Kladde ── */}
      {(() => {
        const titleField = fields.find((f) => f.key === '_title');
        const descField = fields.find((f) => f.key === '_description');
        if (!titleField && !descField) return null;

        const liveTitle = product.title ?? '';
        const draftTitle = titleField ? (fieldEdits[titleField.id] ?? '') : '';
        const titleChanged = titleField ? draftTitle !== liveTitle : false;

        const liveDesc = product.descriptionHtml ?? '';
        const draftDesc = descField ? (fieldEdits[descField.id] ?? '') : '';
        const descChanged = descField ? draftDesc !== liveDesc : false;
        const hasChanges = titleChanged || descChanged;

        return (
          <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
            <button
              type="button"
              className="flex w-full items-center justify-between p-4 text-left md:px-5 hover:bg-gray-50 transition"
              onClick={() => setLiveVsKladdeOpen((prev) => !prev)}
            >
              <div className="flex items-center gap-2.5">
                <svg viewBox="0 0 24 24" className="h-4 w-4 text-gray-400" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 3h6v6"/><path d="m14 10 6.1-6.1"/><path d="M9 21H3v-6"/><path d="m10 14-6.1 6.1"/></svg>
                <span className="text-sm font-semibold text-gray-900">Live vs. Kladde</span>
                {hasChanges ? (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700">Ændringer afventer sync</span>
                ) : (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">Synkroniseret</span>
                )}
              </div>
              <svg viewBox="0 0 24 24" className={`h-4 w-4 text-gray-400 transition-transform ${liveVsKladdeOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
            </button>

            {liveVsKladdeOpen && (
              <div className="border-t border-gray-100 p-4 md:px-5 space-y-4">
                {titleField && (
                  <div>
                    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Titel</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className={`rounded-lg border p-3 ${titleChanged ? 'border-gray-200 bg-gray-50' : 'border-emerald-200 bg-emerald-50/50'}`}>
                        <div className="mb-1 flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-full bg-emerald-500" />
                          <span className="text-[10px] font-medium uppercase tracking-wide text-emerald-700">Live (Shopify)</span>
                        </div>
                        <div className="text-sm text-gray-800">{liveTitle || <span className="text-gray-400 italic">Tom</span>}</div>
                      </div>
                      <div className={`rounded-lg border p-3 ${titleChanged ? 'border-amber-200 bg-amber-50/50' : 'border-emerald-200 bg-emerald-50/50'}`}>
                        <div className="mb-1 flex items-center gap-1.5">
                          <span className={`h-2 w-2 rounded-full ${titleChanged ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                          <span className={`text-[10px] font-medium uppercase tracking-wide ${titleChanged ? 'text-amber-700' : 'text-emerald-700'}`}>Kladde (ePIM)</span>
                        </div>
                        <div className="text-sm text-gray-800">{draftTitle || <span className="text-gray-400 italic">Tom</span>}</div>
                      </div>
                    </div>
                  </div>
                )}
                {descField && (
                  <div>
                    <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Beskrivelse</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className={`rounded-lg border p-3 ${descChanged ? 'border-gray-200 bg-gray-50' : 'border-emerald-200 bg-emerald-50/50'}`}>
                        <div className="mb-1 flex items-center gap-1.5">
                          <span className="h-2 w-2 rounded-full bg-emerald-500" />
                          <span className="text-[10px] font-medium uppercase tracking-wide text-emerald-700">Live (Shopify)</span>
                        </div>
                        {liveDesc ? (
                          <div className="ep-richtext max-h-40 overflow-auto text-sm text-gray-800" dangerouslySetInnerHTML={{ __html: liveDesc }} />
                        ) : (
                          <div className="text-sm text-gray-400 italic">Tom</div>
                        )}
                      </div>
                      <div className={`rounded-lg border p-3 ${descChanged ? 'border-amber-200 bg-amber-50/50' : 'border-emerald-200 bg-emerald-50/50'}`}>
                        <div className="mb-1 flex items-center gap-1.5">
                          <span className={`h-2 w-2 rounded-full ${descChanged ? 'bg-amber-500' : 'bg-emerald-500'}`} />
                          <span className={`text-[10px] font-medium uppercase tracking-wide ${descChanged ? 'text-amber-700' : 'text-emerald-700'}`}>Kladde (ePIM)</span>
                        </div>
                        {draftDesc ? (
                          <div className="ep-richtext max-h-40 overflow-auto text-sm text-gray-800" dangerouslySetInnerHTML={{ __html: draftDesc }} />
                        ) : (
                          <div className="text-sm text-gray-400 italic">Tom</div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      </> /* end indhold tab */
      )}

      {/* ── Varianter tab ── */}
      {activeTab === 'varianter' && (
      <>

      {/* Inventory collapsible */}
      {product.variants && product.variants.length > 0 && (() => {
        const totalInventory = product.variants.reduce((sum, v) => sum + (v.inventoryQuantity ?? 0), 0);
        return (
          <div className="rounded-xl border border-gray-200 overflow-hidden bg-white">
            <button
              type="button"
              className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-gray-50 transition"
              onClick={() => setInventoryOpen((prev) => !prev)}
            >
              <div className="flex items-center gap-3">
                <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Lager</span>
                <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-semibold text-slate-700">
                  {totalInventory.toLocaleString('da-DK')} stk. total
                </span>
              </div>
              <svg viewBox="0 0 24 24" className={`h-3.5 w-3.5 text-gray-400 transition-transform ${inventoryOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
            </button>
            {inventoryOpen && (
              <div className="border-t border-gray-100">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-100">
                      <th className="px-4 py-2 text-left font-semibold text-gray-500 uppercase tracking-wide">Variant</th>
                      <th className="px-4 py-2 text-left font-semibold text-gray-500 uppercase tracking-wide">SKU</th>
                      <th className="px-4 py-2 text-right font-semibold text-gray-500 uppercase tracking-wide">Antal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {product.variants.map((v) => (
                      <tr key={v.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50">
                        <td className="px-4 py-2 text-gray-700">
                          {(v.optionValuesJson ?? []).join(' / ') || v.sku || '—'}
                        </td>
                        <td className="px-4 py-2 font-mono text-gray-500">{v.sku || '—'}</td>
                        <td className={`px-4 py-2 text-right font-semibold tabular-nums ${(v.inventoryQuantity ?? 0) <= 0 ? 'text-red-500' : (v.inventoryQuantity ?? 0) < 10 ? 'text-amber-600' : 'text-gray-800'}`}>
                          {v.inventoryQuantity != null ? v.inventoryQuantity.toLocaleString('da-DK') : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-gray-200 bg-gray-50/50">
                      <td className="px-4 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide" colSpan={2}>Total</td>
                      <td className="px-4 py-2 text-right text-xs font-bold text-gray-800 tabular-nums">{totalInventory.toLocaleString('da-DK')}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        );
      })()}

      {/* Variant table */}
      {product.variants && product.variants.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100">
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Varianter ({product.variants.length})</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-gray-500">
                  <th className="px-3 py-2.5 text-left font-semibold uppercase tracking-wide">Variant</th>
                  <th className="px-3 py-2.5 text-left font-semibold uppercase tracking-wide">SKU</th>
                  <th className="px-3 py-2.5 text-right font-semibold uppercase tracking-wide">Pris</th>
                  <th className="px-3 py-2.5 text-right font-semibold uppercase tracking-wide">Sammenligningspris</th>
                  <th className="px-3 py-2.5 text-right font-semibold uppercase tracking-wide">Vægt</th>
                  <th className="px-3 py-2.5 text-left font-semibold uppercase tracking-wide">
                    <div className="group relative inline-block">
                      Lagerpolitik
                      <div className="pointer-events-none absolute bottom-full left-0 mb-1.5 w-48 rounded-lg bg-gray-900 px-2.5 py-2 text-[11px] text-gray-100 opacity-0 group-hover:opacity-100 transition-opacity z-50 leading-relaxed font-normal normal-case tracking-normal">
                        Stop ved nul lager: produktet kan ikke købes når lageret er tomt. Tillad oversalg: produktet kan stadig købes selvom lageret viser nul.
                        <div className="absolute top-full left-3 border-4 border-transparent border-t-gray-900" />
                      </div>
                    </div>
                  </th>
                  <th className="px-3 py-2.5 text-left font-semibold uppercase tracking-wide">
                    <div className="group relative inline-flex items-center gap-1">
                      Fragtpligtig
                      <svg viewBox="0 0 24 24" className="h-3 w-3 text-gray-300 cursor-help" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                      <div className="pointer-events-none absolute bottom-full left-0 mb-1.5 w-52 rounded-lg bg-gray-900 px-2.5 py-2 text-[11px] text-gray-100 opacity-0 group-hover:opacity-100 transition-opacity z-50 leading-relaxed font-normal normal-case tracking-normal">
                        Kræver produktet fysisk levering/fragt? Slå fra for digitale produkter eller tjenester.
                        <div className="absolute top-full left-3 border-4 border-transparent border-t-gray-900" />
                      </div>
                    </div>
                  </th>
                  <th className="px-3 py-2.5 text-left font-semibold uppercase tracking-wide">
                    <div className="group relative inline-flex items-center gap-1">
                      Momspligtig
                      <svg viewBox="0 0 24 24" className="h-3 w-3 text-gray-300 cursor-help" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                      <div className="pointer-events-none absolute bottom-full left-0 mb-1.5 w-52 rounded-lg bg-gray-900 px-2.5 py-2 text-[11px] text-gray-100 opacity-0 group-hover:opacity-100 transition-opacity z-50 leading-relaxed font-normal normal-case tracking-normal">
                        Skal der beregnes moms/afgift på dette produkt? Slå fra for momsfritagne varer.
                        <div className="absolute top-full left-3 border-4 border-transparent border-t-gray-900" />
                      </div>
                    </div>
                  </th>
                  <th className="px-3 py-2.5 text-left font-semibold uppercase tracking-wide">
                    <div className="group relative inline-flex items-center gap-1">
                      HS-kode
                      <svg viewBox="0 0 24 24" className="h-3 w-3 text-gray-300 cursor-help" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                      <div className="pointer-events-none absolute bottom-full left-0 mb-1.5 w-56 rounded-lg bg-gray-900 px-2.5 py-2 text-[11px] text-gray-100 opacity-0 group-hover:opacity-100 transition-opacity z-50 leading-relaxed font-normal normal-case tracking-normal">
                        Harmonized System-kode (toldkode), 6-10 cifre. Bruges ved international forsendelse og toldbehandling.
                        <div className="absolute top-full left-3 border-4 border-transparent border-t-gray-900" />
                      </div>
                    </div>
                  </th>
                  <th className="px-3 py-2.5 text-left font-semibold uppercase tracking-wide">
                    <div className="group relative inline-flex items-center gap-1">
                      Oprindelse
                      <svg viewBox="0 0 24 24" className="h-3 w-3 text-gray-300 cursor-help" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                      <div className="pointer-events-none absolute bottom-full left-0 mb-1.5 w-56 rounded-lg bg-gray-900 px-2.5 py-2 text-[11px] text-gray-100 opacity-0 group-hover:opacity-100 transition-opacity z-50 leading-relaxed font-normal normal-case tracking-normal">
                        Oprindelsesland (ISO 3166-1 alpha-2 landekode, fx &quot;CN&quot;, &quot;DE&quot;, &quot;DK&quot;). Bruges ved toldangivelse.
                        <div className="absolute top-full left-3 border-4 border-transparent border-t-gray-900" />
                      </div>
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {product.variants.map((v) => (
                  <tr key={v.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50/50">
                    <td className="px-3 py-2">
                      <a href={`/variants/${v.id}`} className="font-medium text-indigo-600 hover:text-indigo-800 hover:underline inline-flex items-center gap-1">
                        <span>{(v.optionValuesJson ?? []).join(' / ') || v.sku || 'Åbn'}</span>
                        {(v.optionValuesJson ?? []).includes('Default Title') && (
                          <div className="group relative">
                            <svg viewBox="0 0 24 24" className="h-3 w-3 text-gray-300 cursor-help hover:text-gray-400 transition" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                            <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 w-64 rounded-xl bg-gray-900 px-3 py-2.5 text-xs text-gray-100 opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-50 leading-relaxed shadow-xl">
                              <span className="font-semibold">&quot;Default Title&quot;</span> er Shopifys automatiske standardvariant. Shopify opretter denne automatisk når et produkt kun har én variant og ingen tilpassede valgmuligheder (fx størrelse eller farve). Det er ikke et egentligt produktvalg, blot en teknisk placeholder.
                              <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900" />
                            </div>
                          </div>
                        )}
                      </a>
                    </td>
                    <td className="px-3 py-2">
                      <input
                        className="font-mono w-full min-w-[80px] rounded border border-transparent bg-transparent px-1 py-0.5 text-gray-700 hover:border-gray-200 focus:border-indigo-300 focus:bg-white focus:outline-none"
                        value={variantEdits[v.id]?.sku ?? ''}
                        onChange={(e) => setVariantEdits(prev => ({ ...prev, [v.id]: { ...prev[v.id], sku: e.target.value } }))}
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex items-center gap-0.5">
                        <input
                          className="w-[72px] rounded border border-transparent bg-transparent px-1 py-0.5 text-gray-900 font-medium hover:border-gray-200 focus:border-indigo-300 focus:bg-white focus:outline-none text-right tabular-nums"
                          value={variantEdits[v.id]?.price ?? ''}
                          onChange={(e) => setVariantEdits(prev => ({ ...prev, [v.id]: { ...prev[v.id], price: e.target.value } }))}
                        />
                        <span className="text-gray-400 font-normal">kr.</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex items-center gap-0.5">
                        <input
                          className={`w-[72px] rounded border text-right tabular-nums hover:border-gray-200 focus:border-indigo-300 focus:bg-white focus:outline-none ${
                            !(variantEdits[v.id]?.compareAtPrice) ? 'border-dashed border-gray-200 bg-transparent text-gray-300' : 'border-transparent bg-transparent text-gray-400'
                          }`}
                          value={variantEdits[v.id]?.compareAtPrice ?? ''}
                          onChange={(e) => setVariantEdits(prev => ({ ...prev, [v.id]: { ...prev[v.id], compareAtPrice: e.target.value } }))}
                          placeholder="Tom"
                        />
                        <span className="text-gray-300 font-normal">kr.</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex items-center gap-1 justify-end">
                        <input
                          type="number"
                          className="w-14 rounded border border-transparent bg-transparent px-1 py-0.5 text-gray-700 hover:border-gray-200 focus:border-indigo-300 focus:bg-white focus:outline-none text-right tabular-nums"
                          value={variantEdits[v.id]?.weight ?? ''}
                          onChange={(e) => setVariantEdits(prev => ({ ...prev, [v.id]: { ...prev[v.id], weight: e.target.value } }))}
                        />
                        <select
                          className="rounded border border-transparent bg-transparent px-1 py-0.5 text-gray-400 hover:border-gray-200 focus:border-indigo-300 focus:outline-none"
                          value={variantEdits[v.id]?.weightUnit ?? 'KILOGRAMS'}
                          onChange={(e) => setVariantEdits(prev => ({ ...prev, [v.id]: { ...prev[v.id], weightUnit: e.target.value } }))}
                        >
                          <option value="KILOGRAMS">kg</option>
                          <option value="GRAMS">g</option>
                          <option value="POUNDS">lb</option>
                          <option value="OUNCES">oz</option>
                        </select>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <select
                        className="rounded border border-transparent bg-transparent px-1 py-0.5 text-gray-700 hover:border-gray-200 focus:border-indigo-300 focus:outline-none"
                        value={variantEdits[v.id]?.inventoryPolicy ?? 'DENY'}
                        onChange={(e) => setVariantEdits(prev => ({ ...prev, [v.id]: { ...prev[v.id], inventoryPolicy: e.target.value } }))}
                      >
                        <option value="DENY">Stop ved nul lager</option>
                        <option value="CONTINUE">Tillad oversalg</option>
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                        checked={variantEdits[v.id]?.requiresShipping ?? true}
                        onChange={(e) => setVariantEdits(prev => ({ ...prev, [v.id]: { ...prev[v.id], requiresShipping: e.target.checked } }))}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                        checked={variantEdits[v.id]?.taxable ?? true}
                        onChange={(e) => setVariantEdits(prev => ({ ...prev, [v.id]: { ...prev[v.id], taxable: e.target.checked } }))}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="inline-flex items-center gap-1">
                        <input
                          className="font-mono w-24 rounded border border-transparent bg-transparent px-1 py-0.5 text-gray-700 hover:border-gray-200 focus:border-indigo-300 focus:bg-white focus:outline-none"
                          value={variantEdits[v.id]?.hsCode ?? ''}
                          placeholder="Ikke angivet"
                          maxLength={20}
                          onChange={(e) => setVariantEdits(prev => ({ ...prev, [v.id]: { ...prev[v.id], hsCode: e.target.value } }))}
                        />
                        <button
                          type="button"
                          title="AI-forslag til HS-kode"
                          disabled={variantAiSuggestLoading[`${v.id}_hsCode`]}
                          className="flex items-center justify-center h-5 w-5 rounded text-indigo-400 hover:text-indigo-600 hover:bg-indigo-50 disabled:opacity-40 transition"
                          onClick={async () => {
                            setVariantAiSuggestLoading(prev => ({ ...prev, [`${v.id}_hsCode`]: true }));
                            try {
                              const res = await apiFetch<{ value: string }>(`/variants/${v.id}/ai-suggest`, {
                                method: 'POST',
                                body: JSON.stringify({ field: 'hsCode' }),
                              });
                              if (res.value) setVariantEdits(prev => ({ ...prev, [v.id]: { ...prev[v.id], hsCode: res.value } }));
                            } catch {
                              toast.error('AI-forslag fejlede');
                            } finally {
                              setVariantAiSuggestLoading(prev => ({ ...prev, [`${v.id}_hsCode`]: false }));
                            }
                          }}
                        >
                          {variantAiSuggestLoading[`${v.id}_hsCode`]
                            ? <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                            : <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M19 15l.75 2.25L22 18l-2.25.75L19 21l-.75-2.25L16 18l2.25-.75z"/></svg>
                          }
                        </button>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="inline-flex items-center gap-1">
                        <input
                          className="font-mono w-12 rounded border border-transparent bg-transparent px-1 py-0.5 text-gray-700 hover:border-gray-200 focus:border-indigo-300 focus:bg-white focus:outline-none uppercase"
                          value={variantEdits[v.id]?.countryOfOrigin ?? ''}
                          placeholder="Ikke angivet"
                          maxLength={2}
                          onChange={(e) => setVariantEdits(prev => ({ ...prev, [v.id]: { ...prev[v.id], countryOfOrigin: e.target.value.toUpperCase() } }))}
                        />
                        <button
                          type="button"
                          title="AI-forslag til oprindelsesland"
                          disabled={variantAiSuggestLoading[`${v.id}_countryOfOrigin`]}
                          className="flex items-center justify-center h-5 w-5 rounded text-indigo-400 hover:text-indigo-600 hover:bg-indigo-50 disabled:opacity-40 transition"
                          onClick={async () => {
                            setVariantAiSuggestLoading(prev => ({ ...prev, [`${v.id}_countryOfOrigin`]: true }));
                            try {
                              const res = await apiFetch<{ value: string }>(`/variants/${v.id}/ai-suggest`, {
                                method: 'POST',
                                body: JSON.stringify({ field: 'countryOfOrigin' }),
                              });
                              if (res.value) setVariantEdits(prev => ({ ...prev, [v.id]: { ...prev[v.id], countryOfOrigin: res.value.toUpperCase().slice(0, 2) } }));
                            } catch {
                              toast.error('AI-forslag fejlede');
                            } finally {
                              setVariantAiSuggestLoading(prev => ({ ...prev, [`${v.id}_countryOfOrigin`]: false }));
                            }
                          }}
                        >
                          {variantAiSuggestLoading[`${v.id}_countryOfOrigin`]
                            ? <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                            : <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M19 15l.75 2.25L22 18l-2.25.75L19 21l-.75-2.25L16 18l2.25-.75z"/></svg>
                          }
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-2 px-4 py-3 border-t border-gray-100 bg-gray-50/50">
            <button
              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60 transition flex items-center gap-1.5"
              disabled={isSaving}
              onClick={saveAndSyncToShopify}
            >
              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>
              {isSaving ? 'Gemmer...' : 'Gem og synkronisér til Shopify'}
            </button>
          </div>
        </div>
      )}

      </> /* end varianter tab */
      )}

      {/* ── Translations tab ── */}
      {activeTab === 'oversaettelser' && (
        <section className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="px-5 py-4 space-y-4">
            {/* Header + language selector */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-50">
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-violet-600" fill="none" stroke="currentColor" strokeWidth="2"><path d="m5 8 6 6M4 14l6-6 2-2M2 5h12M7 2h1m4 18 4-8 4 8M20.5 18H22"/></svg>
                </div>
                <div>
                  <div className="text-sm font-semibold text-gray-800">Oversættelser</div>
                  <div className="text-xs text-gray-400 mt-0.5">Synkroniseres til Shopify Markets</div>
                </div>
              </div>
              {shopLocales.filter((l) => l.published).length > 0 ? (
                <div className="flex items-center gap-2 flex-wrap">
                  {shopLocales.filter((l) => l.published).map((l) => (
                    <button
                      key={l.locale}
                      onClick={() => setTranslationLocale(l.locale)}
                      className={`rounded-lg border px-3 py-1 text-xs font-medium transition ${translationLocale === l.locale ? 'border-violet-300 bg-violet-600 text-white' : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'}`}
                    >
                      {l.name}
                    </button>
                  ))}
                </div>
              ) : (
                <span className="text-xs text-gray-400">Ingen oversættelsessprog konfigureret i Shopify Markets</span>
              )}
            </div>
            {/* Fields */}
            {shopLocales.filter((l) => l.published).length > 0 && (
              <div className="space-y-3">
                {[
                  { key: 'title', label: 'Titel', multiline: false },
                  { key: 'descriptionHtml', label: 'Beskrivelse', multiline: true },
                  { key: 'seo_title', label: 'SEO-titel', multiline: false },
                  { key: 'seo_description', label: 'SEO-beskrivelse', multiline: true },
                ].map((f) => {
                  const key = `${translationLocale}__${f.key}`;
                  const val = translationEdits[key] ?? '';
                  const localeName = shopLocales.find((l) => l.locale === translationLocale)?.name ?? translationLocale;
                  return (
                    <div key={f.key}>
                      <label className="block text-xs font-medium text-gray-500 mb-1">{f.label}</label>
                      {f.multiline ? (
                        <textarea
                          className="ep-textarea"
                          rows={3}
                          value={val}
                          onChange={(e) => setTranslationEdits((prev) => ({ ...prev, [key]: e.target.value }))}
                          onBlur={async (e) => {
                            setSavingTranslation(true);
                            try {
                              await apiFetch(`/products/${product.id}/translations`, { method: 'PUT', body: JSON.stringify({ locale: translationLocale, fieldKey: f.key, value: e.target.value }) });
                            } catch { /* ignore */ }
                            setSavingTranslation(false);
                          }}
                          placeholder={`${f.label} på ${localeName}…`}
                        />
                      ) : (
                        <input
                          className="ep-input"
                          value={val}
                          onChange={(e) => setTranslationEdits((prev) => ({ ...prev, [key]: e.target.value }))}
                          onBlur={async (e) => {
                            setSavingTranslation(true);
                            try {
                              await apiFetch(`/products/${product.id}/translations`, { method: 'PUT', body: JSON.stringify({ locale: translationLocale, fieldKey: f.key, value: e.target.value }) });
                            } catch { /* ignore */ }
                            setSavingTranslation(false);
                          }}
                          placeholder={`${f.label} på ${localeName}…`}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {savingTranslation && <p className="text-xs text-gray-400">Gemmer…</p>}
            {shopLocales.filter((l) => l.published).length > 0 && (
              <p className="text-[11px] text-gray-400">Felterne gemmes automatisk når du forlader dem. Synkronisering til Shopify Markets sker via standard-synk-knappen.</p>
            )}
          </div>
        </section>
      )}

      {/* ── History tab ── */}
      {activeTab === 'historik' && (
      <section className="rounded-xl border border-gray-200 bg-white overflow-hidden">
        <div className="flex items-center gap-2 p-4 md:px-5 border-b border-gray-100">
          <svg viewBox="0 0 24 24" className="h-4 w-4 text-gray-500" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/></svg>
          <span className="text-sm font-semibold text-gray-900">Historik</span>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500">{history.length}</span>
        </div>
        {(true) && (
          <div className="border-t border-gray-100 p-4 md:px-5 space-y-3">
            <div className="flex gap-2">
              <button
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${historyTab === 'changes' ? 'bg-indigo-600 text-white' : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50'}`}
                onClick={() => setHistoryTab('changes')}
              >
                Ændringer ({detailedHistory.length})
              </button>
              <button
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${historyTab === 'snapshots' ? 'bg-indigo-600 text-white' : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50'}`}
                onClick={() => setHistoryTab('snapshots')}
              >
                Snapshots ({historySnapshots.length})
              </button>
            </div>

            {historyTab === 'changes' && (
              <div className="space-y-2 max-h-[500px] overflow-y-auto">
                {detailedHistory.length === 0 && <div className="text-sm text-gray-400">Ingen ændringer registreret.</div>}
                {detailedHistory.map((log) => {
                  const sourceLabels: Record<string, string> = {
                    user: 'Bruger',
                    ai: 'AI',
                    shopify_webhook: 'Shopify',
                    import: 'Import',
                    conflict_hold: 'Konflikt',
                  };
                  const sourceColors: Record<string, string> = {
                    user: 'bg-blue-100 text-blue-700',
                    ai: 'bg-purple-100 text-purple-700',
                    shopify_webhook: 'bg-emerald-100 text-emerald-700',
                    import: 'bg-orange-100 text-orange-700',
                    conflict_hold: 'bg-red-100 text-red-700',
                  };
                  const userName = log.user
                    ? [log.user.firstName, log.user.lastName].filter(Boolean).join(' ') || log.user.email
                    : null;
                  return (
                    <details key={log.id} className="rounded-lg border border-gray-100 bg-gray-50/50">
                      <summary className="cursor-pointer px-3 py-2 text-sm flex items-center gap-2">
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${sourceColors[log.source] ?? 'bg-gray-100 text-gray-600'}`}>
                          {sourceLabels[log.source] ?? log.source}
                        </span>
                        {log.fieldKey && <span className="text-xs font-mono text-gray-500">{log.fieldKey}</span>}
                        {userName && <span className="text-xs text-gray-400">af {userName}</span>}
                        <span className="ml-auto text-xs text-gray-400">{new Date(log.createdAt).toLocaleString('da-DK', { dateStyle: 'short', timeStyle: 'short' })}</span>
                      </summary>
                      <div className="border-t border-gray-100 px-3 py-2 space-y-2">
                        {log.beforeJson != null && (
                          <div>
                            <div className="text-[10px] font-medium uppercase tracking-wide text-red-500 mb-0.5">Før</div>
                            <pre className="rounded bg-red-50 p-2 text-xs text-red-800 overflow-auto max-h-32 whitespace-pre-wrap">{typeof log.beforeJson === 'string' ? log.beforeJson : JSON.stringify(log.beforeJson, null, 2)}</pre>
                          </div>
                        )}
                        {log.afterJson != null && (
                          <div>
                            <div className="text-[10px] font-medium uppercase tracking-wide text-emerald-600 mb-0.5">Efter</div>
                            <pre className="rounded bg-emerald-50 p-2 text-xs text-emerald-800 overflow-auto max-h-32 whitespace-pre-wrap">{typeof log.afterJson === 'string' ? log.afterJson : JSON.stringify(log.afterJson, null, 2)}</pre>
                          </div>
                        )}
                        {log.beforeJson == null && log.afterJson == null && (
                          <div className="text-xs text-gray-400">Ingen detaljer tilgængelige.</div>
                        )}
                      </div>
                    </details>
                  );
                })}
              </div>
            )}

            {historyTab === 'snapshots' && (
              <div className="space-y-2 max-h-[500px] overflow-y-auto">
                {historySnapshots.length === 0 && <div className="text-sm text-gray-400">Ingen snapshots endnu.</div>}
                {historySnapshots.map((snap) => (
                  <details key={snap.id} className="rounded-lg border border-gray-100 bg-gray-50/50">
                    <summary className="cursor-pointer px-3 py-2 text-sm flex items-center gap-2">
                      <span className="shrink-0 rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-700">{snap.reason}</span>
                      <span className="ml-auto text-xs text-gray-400">{new Date(snap.createdAt).toLocaleString('da-DK', { dateStyle: 'short', timeStyle: 'short' })}</span>
                    </summary>
                    <div className="border-t border-gray-100 px-3 py-2">
                      <pre className="rounded bg-gray-100 p-2 text-xs text-gray-700 overflow-auto max-h-48 whitespace-pre-wrap">{JSON.stringify(snap.blobJson, null, 2)}</pre>
                    </div>
                  </details>
                ))}
              </div>
            )}
          </div>
        )}
      </section>
      )} {/* end historik tab */}

      {/* ── Sticky save bar — appears when there are unsaved changes or pending sync ── */}
      {(hasUnsavedChanges || isPendingSync || hasDraft) && (
        <div className="fixed bottom-0 left-0 right-0 z-50 border-t border-indigo-100 bg-white/95 backdrop-blur-sm px-4 py-3 shadow-[0_-4px_24px_rgba(0,0,0,0.08)] md:left-[280px]">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm">
              {hasUnsavedChanges ? (
                <>
                  <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
                  <span className="text-amber-700">Ugemte ændringer</span>
                  {draftSaveStatus === 'saving' && <span className="text-xs text-slate-400">· Auto-gemmer kladde…</span>}
                  {draftSaveStatus === 'saved' && <span className="text-xs text-emerald-600">· Kladde gemt</span>}
                </>
              ) : hasDraft ? (
                <>
                  <span className="h-2 w-2 rounded-full bg-violet-400 animate-pulse" />
                  <span className="text-violet-700">Kladde klar til synkronisering</span>
                  <span className="text-xs text-slate-400">· Dine ændringer er gemt som kladde</span>
                </>
              ) : (
                <>
                  <span className="h-2 w-2 rounded-full bg-orange-400 animate-pulse" />
                  <span className="text-orange-700">Afventer Shopify sync</span>
                  <span className="text-xs text-slate-400">· Gemt lokalt, men ikke skubbet til Shopify endnu</span>
                </>
              )}
            </div>
            <div className="flex items-center gap-2">
              {(hasUnsavedChanges || hasDraft) && (
                <button
                  className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-500 hover:text-red-600 hover:border-red-200 disabled:opacity-60 transition"
                  disabled={isSaving}
                  onClick={() => void discardDraft()}
                  title="Kassér alle lokale ændringer og gå tilbage til senest gemte version"
                >
                  Kassér kladde
                </button>
              )}
              {hasUnsavedChanges && (
                <button
                  className="rounded-lg border border-indigo-200 bg-white px-3 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-60 transition"
                  disabled={isSaving}
                  onClick={saveFieldValues}
                  title="Gem lokalt uden at synkronisere til Shopify"
                >
                  {isSaving ? 'Gemmer...' : 'Gem kladde'}
                </button>
              )}
              <button
                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60 transition flex items-center gap-1.5"
                disabled={isSaving}
                onClick={saveAndSyncToShopify}
                title="Gem og send til Shopify med det samme"
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M5 12h14" /><path d="m13 6 6 6-6 6" />
                </svg>
                {isSaving ? 'Gemmer...' : hasUnsavedChanges ? 'Gem og synkronisér' : 'Synkronisér nu'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Lightbox ── */}
      {lightboxIndex !== null && imageEdits.length > 0 && (() => {
        const clampedIndex = Math.max(0, Math.min(lightboxIndex, imageEdits.length - 1));
        const current = imageEdits[clampedIndex];
        const goPrev = () => setLightboxIndex((clampedIndex - 1 + imageEdits.length) % imageEdits.length);
        const goNext = () => setLightboxIndex((clampedIndex + 1) % imageEdits.length);
        return (
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm"
            onClick={() => setLightboxIndex(null)}
          >
            {/* Close button */}
            <button
              className="absolute top-4 right-4 text-white/70 hover:text-white text-2xl font-light transition"
              onClick={(e) => { e.stopPropagation(); setLightboxIndex(null); }}
            >
              ✕
            </button>
            {/* Prev arrow */}
            {imageEdits.length > 1 && (
              <button
                className="absolute left-4 top-1/2 -translate-y-1/2 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/25 transition"
                onClick={(e) => { e.stopPropagation(); goPrev(); }}
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m15 18-6-6 6-6"/></svg>
              </button>
            )}
            {/* Image */}
            <img
              src={current.url}
              alt={current.altText ?? `Billede ${clampedIndex + 1}`}
              className="max-h-[85vh] max-w-[90vw] rounded-xl object-contain shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            />
            {/* Next arrow */}
            {imageEdits.length > 1 && (
              <button
                className="absolute right-4 top-1/2 -translate-y-1/2 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/25 transition"
                onClick={(e) => { e.stopPropagation(); goNext(); }}
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m9 18 6-6-6-6"/></svg>
              </button>
            )}
            {/* Counter */}
            {imageEdits.length > 1 && (
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/40 px-3 py-1 text-xs text-white/80">
                {clampedIndex + 1} / {imageEdits.length}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}
