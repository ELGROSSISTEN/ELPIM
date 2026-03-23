'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ColumnDef, ColumnOrderState, ColumnSizingState, OnChangeFn, SortingState, VisibilityState, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { API_URL, apiFetch, getActiveShopId, getToken } from '../lib/api';
import { toast } from './toaster';
import { registerBackgroundActivityJobs } from '../lib/background-activity';
import { StatusBadge } from './command-palette';

type PromptTemplate = {
  id: string;
  name: string;
  body: string;
  active: boolean;
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

const AI_PROMPT_PRESETS: Array<{ label: string; instruction: string }> = [
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

const RECENT_COMPETITOR_LINKS_KEY = 'epim_recent_competitor_links';

const normalizeCompetitorInput = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parseUrl = (candidate: string): URL | null => { try { return new URL(candidate); } catch { return null; } };
  const direct = parseUrl(trimmed);
  if (direct && (direct.protocol === 'http:' || direct.protocol === 'https:')) return `${direct.protocol}//${direct.hostname}`;
  const prefixed = parseUrl(`https://${trimmed}`);
  if (prefixed && prefixed.hostname.includes('.')) return `https://${prefixed.hostname}`;
  return null;
};

const domainFromUrl = (url: string): string => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
};

type Product = {
  id: string;
  title: string;
  handle: string;
  vendor?: string;
  productType?: string;
  status?: string;
  updatedAt: string;
  lastShopifySyncAt?: string | null;
  shopifyUpdatedAt?: string | null;
  createdVia?: string | null;
  createdAt?: string;
  syncStatus?: string;
  hasDraft?: boolean;
  descriptionHtml?: string | null;
  imagesJson?: Array<{ url: string; altText?: string }>;
  variants?: Array<{
    id: string;
    inventoryQuantity?: number | null;
    weight?: number | null;
    weightUnit?: string | null;
    price?: string | null;
    sku?: string | null;
    barcode?: string | null;
    hsCode?: string | null;
    countryOfOrigin?: string | null;
  }>;
  fieldValues?: Array<{
    id: string;
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
};

type ProductsGridProps = {
  initial: Product[];
  fields: FieldDefinition[];
  total: number;
  pendingSyncCount?: number;
  query: string;
  page: number;
  pageSize: number;
  isLoading?: boolean;
  sorting: SortingState;
  onQueryChange: (nextQuery: string) => void;
  onPageChange: (nextPage: number) => void;
  onPageSizeChange: (nextPageSize: number) => void;
  onSortingChange: OnChangeFn<SortingState>;
  onFetchAllForBulk?: () => Promise<Product[]>;
};

type VariantRow = NonNullable<Product['variants']>[number];

type VariantPatch = {
  sku?: string;
  barcode?: string;
  price?: string;
  weight?: number;
  weightUnit?: string;
  hsCode?: string;
  countryOfOrigin?: string;
};

type VisibleCol = { id: string; getSize: () => number };

function VariantTableRow({ variant, visibleColumns, onSave }: {
  variant: VariantRow;
  visibleColumns: VisibleCol[];
  onSave: (patch: VariantPatch) => void;
}) {
  const [sku, setSku] = useState(variant.sku ?? '');
  const [barcode, setBarcode] = useState(variant.barcode ?? '');
  const [hsCode, setHsCode] = useState(variant.hsCode ?? '');
  const [countryOfOrigin, setCountryOfOrigin] = useState(variant.countryOfOrigin ?? '');
  const [saving, setSaving] = useState(false);

  const save = async (patch: VariantPatch) => {
    if (Object.keys(patch).length === 0) return;
    setSaving(true);
    try { await onSave(patch); } finally { setSaving(false); }
  };

  const handleBlur = (field: keyof VariantPatch, value: string) => {
    const trimmed = value.trim();
    const originals: Record<string, string> = {
      sku: variant.sku ?? '',
      barcode: variant.barcode ?? '',
      hsCode: variant.hsCode ?? '',
      countryOfOrigin: variant.countryOfOrigin ?? '',
    };
    if (trimmed === (originals[field] ?? '')) return;
    void save({ [field]: trimmed });
  };

  const inputCls = 'w-full bg-transparent border border-transparent rounded px-1.5 py-0.5 text-xs text-slate-700 focus:outline-none focus:border-indigo-400 focus:bg-white hover:border-slate-200 transition-colors';

  return (
    <tr className={`border-b border-slate-100 bg-indigo-50/10 ${saving ? 'opacity-60' : ''}`}>
      {visibleColumns.map((col) => {
        const w = col.getSize();
        switch (col.id) {
          case 'expand':
            return (
              <td key={col.id} style={{ width: w }} className="py-1 text-center">
                <span className="inline-block w-px h-4 bg-slate-200 mx-auto" />
              </td>
            );
          case 'select':
          case 'thumbnail':
          case 'pimSync':
          case 'quality':
            return <td key={col.id} style={{ width: w }} />;
          case 'title':
            return (
              <td key={col.id} style={{ width: w }} className="px-2.5 py-1 pl-8">
                <span className="text-xs text-slate-400 font-mono">{variant.sku ? variant.sku : <span className="text-slate-300 italic">Ingen SKU</span>}</span>
              </td>
            );
          case 'sku':
            return (
              <td key={col.id} style={{ width: w }} className="px-2 py-1">
                <input className={inputCls} value={sku} onChange={(e) => setSku(e.target.value)} onBlur={(e) => handleBlur('sku', e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} placeholder="—" />
              </td>
            );
          case 'barcode':
            return (
              <td key={col.id} style={{ width: w }} className="px-2 py-1">
                <input className={inputCls} value={barcode} onChange={(e) => setBarcode(e.target.value)} onBlur={(e) => handleBlur('barcode', e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} placeholder="—" />
              </td>
            );
          case 'hsCode':
            return (
              <td key={col.id} style={{ width: w }} className="px-2 py-1">
                <input className={inputCls} value={hsCode} onChange={(e) => setHsCode(e.target.value)} onBlur={(e) => handleBlur('hsCode', e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} placeholder="—" />
              </td>
            );
          case 'countryOfOrigin':
            return (
              <td key={col.id} style={{ width: w }} className="px-2 py-1">
                <input className={`${inputCls} uppercase`} value={countryOfOrigin} onChange={(e) => setCountryOfOrigin(e.target.value.toUpperCase())} onBlur={(e) => handleBlur('countryOfOrigin', e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} placeholder="—" maxLength={2} />
              </td>
            );
          case 'totalInventory':
            return (
              <td key={col.id} style={{ width: w }} className="px-2.5 py-1 text-xs text-slate-500 tabular-nums text-right">
                {variant.inventoryQuantity != null ? variant.inventoryQuantity.toLocaleString('da-DK') : '—'}
              </td>
            );
          default:
            return <td key={col.id} style={{ width: w }} />;
        }
      })}
    </tr>
  );
}

export function ProductsGrid({
  initial,
  fields,
  total,
  pendingSyncCount: pendingSyncCountProp,
  query,
  page,
  pageSize,
  isLoading = false,
  sorting,
  onQueryChange,
  onPageChange,
  onPageSizeChange,
  onSortingChange,
  onFetchAllForBulk,
}: ProductsGridProps) {
  const router = useRouter();
  const [rows, setRows] = useState<Product[]>(initial);
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [allProductsSelected, setAllProductsSelected] = useState(false);
  const [bulkStatusMenuOpen, setBulkStatusMenuOpen] = useState(false);
  const [bulkConfirmDelete, setBulkConfirmDelete] = useState(false);
  const [bulkActionLoading, setBulkActionLoading] = useState<string | null>(null);
  const bulkStatusMenuRef = useRef<HTMLDivElement>(null);

  // Export modal
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportFieldsSelected, setExportFieldsSelected] = useState<Set<string>>(
    new Set(['title', 'sku', 'price', 'hsCode', 'countryOfOrigin']),
  );
  const [exportIncludeDrafts, setExportIncludeDrafts] = useState(false);

  // Bulk customs
  type CustomsFieldResult = { value?: string; status: 'ok' | 'unsure' | 'error' };
  type CustomsResult = {
    variantId: string;
    sku: string;
    productTitle: string;
    hsCode?: CustomsFieldResult;
    countryOfOrigin?: CustomsFieldResult;
    weight?: CustomsFieldResult;
  };
  const [bulkCustomsOpen, setBulkCustomsOpen] = useState(false);
  const [bulkCustomsFields, setBulkCustomsFields] = useState({ hsCode: true, countryOfOrigin: true, weight: false });
  const [bulkCustomsWeightUnit, setBulkCustomsWeightUnit] = useState<'KILOGRAMS' | 'GRAMS' | 'POUNDS' | 'OUNCES'>('KILOGRAMS');
  const [bulkCustomsRunning, setBulkCustomsRunning] = useState(false);
  const [bulkCustomsDone, setBulkCustomsDone] = useState(false);
  const [bulkCustomsProgress, setBulkCustomsProgress] = useState({ done: 0, total: 0 });
  const [bulkCustomsResults, setBulkCustomsResults] = useState<CustomsResult[]>([]);
  const [bulkCustomsAutoSaved, setBulkCustomsAutoSaved] = useState(0);
  const bulkCustomsCancelRef = useRef(false);
  const [pending, setPending] = useState<Record<string, Partial<Product>>>({});
  const [message, setMessage] = useState('');
  const [isSyncingPending, setIsSyncingPending] = useState(false);

  // --- Full AI state (matches single-product page) ---
  const [aiFieldId, setAiFieldId] = useState('');
  const [aiInstruction, setAiInstruction] = useState('Skriv en skarp og SEO-optimeret værdi til det valgte felt, baseret på produktdata.');
  const [aiUseHtmlOutput, setAiUseHtmlOutput] = useState(false);
  const [aiUseWebSearch, setAiUseWebSearch] = useState(false);
  const [aiOutputLength, setAiOutputLength] = useState<'fra' | 'kort' | 'mellem' | 'lang'>('mellem');
  const [aiKeywords, setAiKeywords] = useState('');
  const [aiNegativeKeywords, setAiNegativeKeywords] = useState('');
  const [brandVoiceLock, setBrandVoiceLock] = useState(true);
  const [brandVoiceGuide, setBrandVoiceGuide] = useState('Professionel tone: teknisk kompetent, tillidsvækkende, konkret og handlingsorienteret. Undgå hype og fluffy vendinger.');
  const [competitorLinksInput, setCompetitorLinksInput] = useState('');
  const [recentCompetitorLinks, setRecentCompetitorLinks] = useState<string[]>([]);
  const [reusableSources, setReusableSources] = useState<ReusableSource[]>([]);
  const [savedPrompts, setSavedPrompts] = useState<PromptTemplate[]>([]);
  const [quickPresets, setQuickPresets] = useState<Array<{ label: string; instruction: string }>>(AI_PROMPT_PRESETS);
  const [selectedPromptId, setSelectedPromptId] = useState('');
  const [isApplyingAi, setIsApplyingAi] = useState(false);
  const [activeAiBatchJobId, setActiveAiBatchJobId] = useState<string | null>(null);
  const [pendingBulkWebSearchIds, setPendingBulkWebSearchIds] = useState<string[] | null>(null);
  const [aiBatchPanelOpen, setAiBatchPanelOpen] = useState(false);
  const [aiLaunching, setAiLaunching] = useState(false);
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [sourcesOnly, setSourcesOnly] = useState(false);

  type AiPreviewState = {
    target: 'selected' | 'visible';
    allIds: string[];
    triedIndex: number;
    previewJobId: string | null;
    previewResult: string | null;
    previewProductTitle: string;
  };
  const [aiPreview, setAiPreview] = useState<AiPreviewState | null>(null);
  const [aiNotifyEmail, setAiNotifyEmail] = useState('');
  const [customsNotifyEmail, setCustomsNotifyEmail] = useState('');

  // Alt-text
  const [altTextModalOpen, setAltTextModalOpen] = useState(false);
  const [altTextNotifyEmail, setAltTextNotifyEmail] = useState('');
  const [altTextRunning, setAltTextRunning] = useState(false);
  const [altTextJobId, setAltTextJobId] = useState<string | null>(null);

  // Quality rules
  type QualityRule = { id: string; name: string; field: string; operator: string; value?: string | null; severity: string; active: boolean };
  const [qualityRules, setQualityRules] = useState<QualityRule[]>([]);

  // Expand rows for inline variant editing
  const [expandedProductIds, setExpandedProductIds] = useState<Set<string>>(new Set());
  const [autoExpand, setAutoExpand] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try { return window.localStorage.getItem('epim_grid_autoexpand') === '1'; } catch { return false; }
  });

  // Sync status sets derived from server-computed syncStatus
  const serverPendingIds = useMemo(
    () => new Set(rows.filter((row) => row.syncStatus === 'afventer_sync').map((row) => row.id)),
    [rows],
  );

  const conflictIds = useMemo(
    () => new Set(rows.filter((row) => row.syncStatus === 'konflikt').map((row) => row.id)),
    [rows],
  );

  // sorting is lifted to parent — server-side
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({ sku: false, hsCode: false, countryOfOrigin: false });
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>({});
  const [columnOrder, setColumnOrder] = useState<ColumnOrderState>([]);
  const [columnDropdownOpen, setColumnDropdownOpen] = useState(false);
  const columnDropdownRef = useRef<HTMLDivElement>(null);
  const [dragColumnId, setDragColumnId] = useState<string | null>(null);

  const columnPrefsKey = useMemo(() => {
    const signature = fields.map((field) => field.id).join('-');
    return `epim_products_grid_prefs_${signature}`;
  }, [fields]);

  useEffect(() => {
    setRows(initial);
  }, [initial]);

  useEffect(() => {
    setSelectedProductIds((prev) => prev.filter((id) => initial.some((row) => row.id === id)));
    setAllProductsSelected(false); // reset when page changes
  }, [initial]);

  useEffect(() => {
    const firstProductField = fields.find((field) => field.scope === 'product');
    if (!firstProductField) {
      setAiFieldId('');
      return;
    }
    if (!aiFieldId || !fields.some((field) => field.id === aiFieldId && field.scope === 'product')) {
      setAiFieldId(firstProductField.id);
    }
  }, [aiFieldId, fields]);

  // Load settings, prompts, sources for AI panel (same data as single-product page)
  useEffect(() => {
    Promise.all([
      apiFetch<{ sources: ReusableSource[] }>('/sources'),
      apiFetch<{ prompts: PromptTemplate[] }>('/prompts'),
      apiFetch<{ settings: Array<{ key: string; valueJson: unknown }> }>('/settings'),
      apiFetch<{ quickPresets: Array<{ label: string; instruction: string }> | null }>('/shops/ai-settings').catch(() => ({ quickPresets: null })),
    ])
      .then(([sourceResponse, promptsResponse, settingsResponse, aiSettingsResponse]) => {
        setReusableSources(sourceResponse.sources.filter((source) => source.active));
        const activePrompts = promptsResponse.prompts.filter((prompt) => prompt.active);
        setSavedPrompts(activePrompts);
        if (activePrompts[0]) setSelectedPromptId(activePrompts[0].id);

        const settingsMap = settingsResponse.settings.reduce<Record<string, unknown>>((acc, item) => { acc[item.key] = item.valueJson; return acc; }, {});
        setBrandVoiceLock(String(settingsMap.brandVoiceLock ?? 'true') !== 'false');
        setBrandVoiceGuide(String(settingsMap.brandVoiceGuide ?? brandVoiceGuide));

        if (aiSettingsResponse.quickPresets && aiSettingsResponse.quickPresets.length > 0) {
          const productPresets = (aiSettingsResponse.quickPresets as Array<{ label: string; instruction: string; scope?: string }>).filter((p) => !p.scope || p.scope === 'product');
          if (productPresets.length > 0) setQuickPresets(productPresets);
        }
      })
      .catch(() => { /* ignore load errors */ });
  }, []); // load once on mount

  // Load quality rules once
  useEffect(() => {
    apiFetch<{ rules: QualityRule[] }>('/quality-rules').then((r) => setQualityRules(r.rules ?? [])).catch(() => {});
  }, []);

  // Load recent competitor links from localStorage
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = window.localStorage.getItem(RECENT_COMPETITOR_LINKS_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored) as string[];
      if (Array.isArray(parsed)) setRecentCompetitorLinks(parsed.filter((item) => typeof item === 'string'));
    } catch { setRecentCompetitorLinks([]); }
  }, []);

  // Auto-enable HTML output when HTML field selected
  useEffect(() => {
    const selectedField = fields.find((field) => field.id === aiFieldId);
    if (selectedField?.type === 'html') setAiUseHtmlOutput(true);
  }, [fields, aiFieldId]);

  // Competitor link parsing (same as single product)
  const competitorUrlLines = useMemo(
    () => competitorLinksInput.split('\n').map((line) => line.trim()).filter(Boolean),
    [competitorLinksInput],
  );
  const parsedCompetitorUrls = useMemo(
    () => competitorUrlLines.map((value) => {
      const normalized = normalizeCompetitorInput(value);
      return { value, normalized, valid: Boolean(normalized) };
    }),
    [competitorUrlLines],
  );
  const validCompetitorUrls = useMemo(
    () => Array.from(new Set(parsedCompetitorUrls.filter((item) => item.valid).map((item) => item.normalized as string))),
    [parsedCompetitorUrls],
  );
  const invalidCompetitorCount = useMemo(
    () => parsedCompetitorUrls.filter((item) => !item.valid).length,
    [parsedCompetitorUrls],
  );

  // Full prompt construction (exactly matches single-product page)
  const aiPrompt = useMemo(() => {
    const fieldLabel = fields.find((field) => field.id === aiFieldId)?.label ?? 'Valgt felt';
    const htmlInstruction = aiUseHtmlOutput
      ? '\n\nHTML OUTPUT AKTIVERET:\nReturnér output som gyldig, semantisk HTML (fx p, h2, ul/li). Returnér kun HTML-koden.'
      : '';
    const webSearchInstruction = aiUseWebSearch
      ? '\n\nWEB SØGNING AKTIVERET:\nDu må aktivt søge på web for opdateret kontekst og formulering.'
      : '';
    const lengthInstruction = aiOutputLength !== 'fra' ? `\n\nØNSKET LÆNGDE: ${aiOutputLength}` : '';
    const keywords = aiKeywords.split(',').map((k) => k.trim()).filter(Boolean);
    const keywordInstruction = keywords.length ? `\n\nSEO NØGLEORD (brug naturligt): ${keywords.join(', ')}` : '';
    const negativeKeywords = aiNegativeKeywords.split(',').map((k) => k.trim()).filter(Boolean);
    const negativeKeywordInstruction = negativeKeywords.length ? `\n\nNEGATIVE KEYWORDS (undgå disse): ${negativeKeywords.join(', ')}` : '';
    const brandVoiceInstruction = brandVoiceLock ? `\n\nBRAND VOICE LOCK (obligatorisk):\n${brandVoiceGuide}` : '';
    const competitorInputs = competitorLinksInput.split('\n').map((line) => line.trim()).filter(Boolean);
    const normalizedCompetitors = competitorInputs.map((input) => normalizeCompetitorInput(input)).filter((value): value is string => Boolean(value));
    const competitorDomains = normalizedCompetitors.map((url) => domainFromUrl(url));
    const competitorInstruction = competitorDomains.length
      ? `\n\nKONKURRENT-DOMÆNER (find selv relevante sider):\n${competitorDomains.map((d) => `- ${d}`).join('\n')}\nSøg aktivt på disse domæner (fx med site:${competitorDomains[0]} + relevante produktord), og brug fundene som inspiration uden at kopiere direkte.`
      : '';

    const activeSourcesToShow = selectedSourceIds.length > 0
      ? reusableSources.filter((s) => selectedSourceIds.includes(s.id))
      : reusableSources.filter((s) => s.feedType === 'static_file' || s.type === 'products');
    const sourcePreview = activeSourcesToShow.length > 0
      ? `\n\n--- DATAKILDER (injiceres automatisk ved generering) ---\n${activeSourcesToShow
          .map((s) => `[${s.name}]: ${s.promptTemplate ?? 'Standard datakilde-prompt'}`)
          .join('\n')}`
      : '';
    const sourcesOnlyPreview = sourcesOnly && activeSourcesToShow.length > 0
      ? '\n\nDATA-BEGRÆNSNING: Generér UDELUKKENDE baseret på de angivne datakilder. Tilføj ingen ekstra viden.'
      : '';

    return `${DEFAULT_AI_BASE_PROMPT}\n\nFELT DU SKAL GENERERE TIL: ${fieldLabel}\n\nSUPPLERENDE INSTRUKTION:\n${aiInstruction}${lengthInstruction}${keywordInstruction}${negativeKeywordInstruction}${brandVoiceInstruction}${htmlInstruction}${webSearchInstruction}${competitorInstruction}${sourcePreview}${sourcesOnlyPreview}`;
  }, [aiInstruction, aiKeywords, aiNegativeKeywords, aiOutputLength, brandVoiceGuide, brandVoiceLock, aiUseHtmlOutput, aiUseWebSearch, competitorLinksInput, fields, aiFieldId, reusableSources, selectedSourceIds, sourcesOnly]);

  const placeholderHelp = useMemo(
    () => ['{{title}}', '{{handle}}', '{{vendor}}', '{{productType}}', '{{descriptionHtml}}', '{{sku}}', '{{barcode}}', '{{price}}', '{{compareAtPrice}}', '{{collections}}'],
    [],
  );

  const applySavedPrompt = (): void => {
    const prompt = savedPrompts.find((p) => p.id === selectedPromptId);
    if (prompt) setAiInstruction(prompt.body);
  };

  const resetAiPanel = (): void => {
    setAiInstruction('Skriv en skarp og SEO-optimeret værdi til det valgte felt, baseret på produktdata.');
    setAiUseHtmlOutput(false);
    setAiUseWebSearch(false);
    setAiOutputLength('mellem');
    setAiKeywords('');
    setAiNegativeKeywords('');
    setCompetitorLinksInput('');
  };

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      const raw = window.localStorage.getItem(columnPrefsKey);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as { visibility?: VisibilityState; sizing?: ColumnSizingState; order?: ColumnOrderState };
      if (parsed.visibility) {
        // Merge saved prefs on top of defaults so new hidden-by-default columns stay hidden
        // for users who never had them in their saved state
        setColumnVisibility((prev) => ({ ...prev, ...parsed.visibility }));
      }
      if (parsed.sizing) {
        setColumnSizing(parsed.sizing);
      }
      if (parsed.order) {
        let filteredOrder = parsed.order.filter((col) => col !== 'open');
        if (!filteredOrder.includes('pimSync')) {
          const selectIdx = filteredOrder.indexOf('select');
          if (selectIdx !== -1) {
            filteredOrder.splice(selectIdx + 1, 0, 'pimSync');
          } else {
            filteredOrder = ['pimSync', ...filteredOrder];
          }
        }
        setColumnOrder(filteredOrder);
      }
    } catch {
      setColumnVisibility({});
      setColumnSizing({});
      setColumnOrder([]);
    }
  }, [columnPrefsKey]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    window.localStorage.setItem(columnPrefsKey, JSON.stringify({ visibility: columnVisibility, sizing: columnSizing, order: columnOrder }));
  }, [columnPrefsKey, columnSizing, columnVisibility, columnOrder]);

  // Auto-expand all products with variants when enabled
  useEffect(() => {
    if (!autoExpand) return;
    setExpandedProductIds(new Set(rows.filter((r) => (r.variants?.length ?? 0) > 0).map((r) => r.id)));
  }, [autoExpand, rows]);

  const toggleAutoExpand = (): void => {
    setAutoExpand((prev) => {
      const next = !prev;
      try { window.localStorage.setItem('epim_grid_autoexpand', next ? '1' : '0'); } catch { /* ignore */ }
      if (!next) setExpandedProductIds(new Set());
      return next;
    });
  };

  // Close column dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (columnDropdownRef.current && !columnDropdownRef.current.contains(e.target as Node)) {
        setColumnDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const hasPending = Object.keys(pending).length > 0;
  const allVisibleIds = useMemo(() => rows.map((row) => row.id), [rows]);
  const selectedCount = selectedProductIds.length;
  const effectiveCount = allProductsSelected ? total : selectedCount;
  const allVisibleSelected = rows.length > 0 && selectedCount === rows.length;
  // Prefer the server-computed total (all products, not just visible page) when available
  const serverPendingCount = pendingSyncCountProp ?? (serverPendingIds.size - conflictIds.size);
  const conflictCount = conflictIds.size;

  const toggleSelectAllVisible = (): void => {
    if (allVisibleSelected) {
      setSelectedProductIds([]);
      setAllProductsSelected(false);
      return;
    }
    setSelectedProductIds(allVisibleIds);
  };

  const toggleSelectProduct = (productId: string): void => {
    setSelectedProductIds((prev) =>
      prev.includes(productId) ? prev.filter((id) => id !== productId) : [...prev, productId],
    );
  };

  // Close bulk status menu on outside click
  useEffect(() => {
    if (!bulkStatusMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (bulkStatusMenuRef.current && !bulkStatusMenuRef.current.contains(e.target as Node)) {
        setBulkStatusMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [bulkStatusMenuOpen]);

  const bulkDelete = async (): Promise<void> => {
    setBulkActionLoading('delete');
    let idsToDelete: string[];
    if (allProductsSelected && onFetchAllForBulk) {
      try {
        const all = await onFetchAllForBulk();
        idsToDelete = all.map((p) => p.id);
      } catch {
        setMessage('Kunne ikke hente alle produkter. Prøv igen.');
        setBulkActionLoading(null);
        return;
      }
    } else {
      idsToDelete = [...selectedProductIds];
    }
    try {
      await apiFetch('/products/bulk-delete', { method: 'POST', body: JSON.stringify({ ids: idsToDelete }) });
      setRows((prev) => prev.filter((r) => !idsToDelete.includes(r.id)));
      setSelectedProductIds([]);
      setAllProductsSelected(false);
      setBulkConfirmDelete(false);
      setMessage(`${idsToDelete.length} ${idsToDelete.length === 1 ? 'produkt slettet' : 'produkter slettet'}.`);
    } catch {
      setMessage('Kunne ikke slette produkter. Prøv igen.');
    } finally {
      setBulkActionLoading(null);
    }
  };

  const bulkSetStatus = async (status: string): Promise<void> => {
    setBulkStatusMenuOpen(false);
    setBulkActionLoading('status');
    let idsToUpdate: string[];
    if (allProductsSelected && onFetchAllForBulk) {
      try {
        const all = await onFetchAllForBulk();
        idsToUpdate = all.map((p) => p.id);
      } catch {
        setMessage('Kunne ikke hente alle produkter. Prøv igen.');
        setBulkActionLoading(null);
        return;
      }
    } else {
      idsToUpdate = [...selectedProductIds];
    }
    try {
      await apiFetch('/products/bulk-status', { method: 'POST', body: JSON.stringify({ ids: idsToUpdate, status }) });
      setRows((prev) => prev.map((r) => idsToUpdate.includes(r.id) ? { ...r, status } : r));
      const label = status === 'ACTIVE' ? 'aktiv' : status === 'DRAFT' ? 'kladde' : 'arkiveret';
      setMessage(`${idsToUpdate.length} ${idsToUpdate.length === 1 ? 'produkt' : 'produkter'} sat til ${label}.`);
    } catch {
      setMessage('Kunne ikke opdatere status. Prøv igen.');
    } finally {
      setBulkActionLoading(null);
    }
  };

  const startBulkCustoms = async (): Promise<void> => {
    const fieldList = [
      ...(bulkCustomsFields.hsCode ? ['hsCode'] : []),
      ...(bulkCustomsFields.countryOfOrigin ? ['countryOfOrigin'] : []),
      ...(bulkCustomsFields.weight ? ['weight'] : []),
    ];
    if (!fieldList.length) return;

    let productsToProcess: Product[];
    if (allProductsSelected && onFetchAllForBulk) {
      try {
        productsToProcess = await onFetchAllForBulk();
      } catch {
        toast.error('Kunne ikke hente alle produkter. Prøv igen.');
        return;
      }
    } else {
      productsToProcess = rows.filter((r) => selectedProductIds.includes(r.id));
    }

    const variants: Array<{ variantId: string; sku: string; productTitle: string }> = [];
    for (const product of productsToProcess) {
      if (!product?.variants?.length) continue;
      for (const v of product.variants) {
        variants.push({ variantId: v.id, sku: v.sku ?? '', productTitle: product.title });
      }
    }
    if (!variants.length) { toast.info('Ingen varianter fundet for de valgte produkter.'); return; }

    // Capture config snapshot — state may be stale inside async loop
    const weightUnit = bulkCustomsWeightUnit;
    const notifyEmail = customsNotifyEmail.trim();

    bulkCustomsCancelRef.current = false;
    setBulkCustomsRunning(true);
    setBulkCustomsDone(false);
    setBulkCustomsProgress({ done: 0, total: variants.length });
    setBulkCustomsResults([]);
    setBulkCustomsAutoSaved(0);

    // Retry on 429 / rate limit with exponential backoff
    const fetchWithRetry = async <T,>(url: string, options: RequestInit): Promise<T> => {
      let delay = 2000;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          return await apiFetch<T>(url, options);
        } catch (err) {
          const msg = err instanceof Error ? err.message : '';
          if (attempt < 3 && (msg.includes('429') || msg.toLowerCase().includes('too many') || msg.toLowerCase().includes('rate limit'))) {
            await new Promise((r) => setTimeout(r, delay));
            delay = Math.min(delay * 2, 30000);
            continue;
          }
          throw err;
        }
      }
      throw new Error('Max retries exceeded');
    };

    // Save a batch of results to the backend (fire-and-forget friendly)
    const autoSaveBatch = async (batch: CustomsResult[]): Promise<number> => {
      const patches = batch
        .filter((r) => r.hsCode?.status === 'ok' || r.countryOfOrigin?.status === 'ok' || r.weight?.status === 'ok')
        .map((r) => ({
          id: r.variantId,
          patch: {
            ...(r.hsCode?.status === 'ok' ? { hsCode: r.hsCode!.value } : {}),
            ...(r.countryOfOrigin?.status === 'ok' ? { countryOfOrigin: r.countryOfOrigin!.value } : {}),
            ...(r.weight?.status === 'ok' ? { weight: parseFloat(r.weight!.value ?? '0'), weightUnit } : {}),
            syncNow: false,
          },
        }));
      if (!patches.length) return 0;
      const CHUNK = 50;
      let saved = 0;
      for (let i = 0; i < patches.length; i += CHUNK) {
        try {
          await apiFetch('/bulk/patch', { method: 'POST', body: JSON.stringify({ products: [], variants: patches.slice(i, i + CHUNK) }) });
          saved += patches.slice(i, i + CHUNK).length;
        } catch { /* silently swallow — results are still shown in the table */ }
      }
      return saved;
    };

    const AUTO_SAVE_EVERY = 25;
    const pending: CustomsResult[] = [];

    for (let i = 0; i < variants.length; i++) {
      if (bulkCustomsCancelRef.current) break;

      const { variantId, sku, productTitle } = variants[i];
      const result: CustomsResult = { variantId, sku, productTitle };

      await Promise.all(fieldList.map(async (field) => {
        try {
          const res = await fetchWithRetry<{ value: string }>(`/variants/${variantId}/ai-suggest`, {
            method: 'POST',
            body: JSON.stringify({ field, ...(field === 'weight' ? { weightUnit } : {}) }),
          });
          (result as Record<string, unknown>)[field] = { value: res.value, status: 'ok' };
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Fejl';
          (result as Record<string, unknown>)[field] = { status: msg.includes('ikke fastslå') || msg.includes('ugyldig') ? 'unsure' : 'error' };
        }
      }));

      setBulkCustomsResults((prev) => [...prev, result]);
      setBulkCustomsProgress((prev) => ({ ...prev, done: prev.done + 1 }));
      pending.push(result);

      // Auto-save every AUTO_SAVE_EVERY results
      if (pending.length >= AUTO_SAVE_EVERY) {
        const batch = pending.splice(0);
        const saved = await autoSaveBatch(batch);
        if (saved > 0) setBulkCustomsAutoSaved((prev) => prev + saved);
      }

      // Throttle between variants to avoid rate limits
      if (i < variants.length - 1 && !bulkCustomsCancelRef.current) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    // Save remaining
    if (pending.length > 0) {
      const saved = await autoSaveBatch(pending);
      if (saved > 0) setBulkCustomsAutoSaved((prev) => prev + saved);
    }

    setBulkCustomsRunning(false);
    setBulkCustomsDone(true);
    toast.success(`Tolddata afsluttet — data gemt automatisk som kladde.`);

    if (notifyEmail) {
      void apiFetch('/notify/bulk-done', {
        method: 'POST',
        body: JSON.stringify({ email: notifyEmail, type: 'tolddata', count: variants.length }),
      }).catch(() => { /* non-critical */ });
    }
  };

  const doExport = async (): Promise<void> => {
    const fields = Array.from(exportFieldsSelected);
    if (!fields.length) return;
    const token = getToken();
    const activeShopId = getActiveShopId();
    try {
      const response = await fetch(`${API_URL}/export.csv?fields=${fields.join(',')}${exportIncludeDrafts ? '&includeDrafts=true' : ''}`, {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(activeShopId ? { 'X-EPIM-Shop-Id': activeShopId } : {}),
        },
      });
      if (!response.ok) { toast.error('Eksport mislykkedes.'); return; }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl; a.download = 'epim-export.csv';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(objectUrl);
      setExportModalOpen(false);
    } catch { toast.error('Eksport mislykkedes.'); }
  };

  const runAiBatch = async (target: 'selected' | 'visible'): Promise<void> => {
    let ids: string[];
    if (target === 'selected') {
      if (allProductsSelected && onFetchAllForBulk) {
        try {
          const all = await onFetchAllForBulk();
          ids = all.map((p) => p.id);
        } catch {
          setMessage('Kunne ikke hente alle produkter. Prøv igen.');
          return;
        }
      } else {
        ids = selectedProductIds;
      }
    } else {
      ids = allVisibleIds;
    }
    if (!ids.length) {
      setMessage(target === 'selected' ? 'Vælg mindst ét produkt først.' : 'Ingen produkter at køre AI på.');
      return;
    }
    if (!aiFieldId) {
      setMessage('Vælg et felt til AI-generering først.');
      return;
    }

    if (typeof window !== 'undefined' && validCompetitorUrls.length > 0) {
      const merged = Array.from(new Set([...validCompetitorUrls, ...recentCompetitorLinks])).slice(0, 10);
      setRecentCompetitorLinks(merged);
      window.localStorage.setItem(RECENT_COMPETITOR_LINKS_KEY, JSON.stringify(merged));
    }

    // Preview phase: run on the first product only, then await user approval
    const firstId = ids[0];
    const firstProduct = rows.find((r) => r.id === firstId);
    setIsApplyingAi(true);
    try {
      const response = await apiFetch<{ jobId: string }>('/ai/apply', {
        method: 'POST',
        body: JSON.stringify({
          fieldDefinitionId: aiFieldId,
          promptTemplate: aiPrompt,
          webSearch: aiUseWebSearch || validCompetitorUrls.length > 0,
          competitorUrls: validCompetitorUrls,
          sourceIds: selectedSourceIds,
          sourcesOnly,
          rows: [{ ownerType: 'product', ownerId: firstId }],
        }),
      });
      setAiPreview({
        target,
        allIds: ids,
        triedIndex: 0,
        previewJobId: response.jobId,
        previewResult: null,
        previewProductTitle: firstProduct?.title ?? firstId,
      });
      setMessage('');
    } catch {
      setMessage('Kunne ikke starte AI preview.');
    } finally {
      setIsApplyingAi(false);
    }
  };

  const tryAnotherProduct = async (): Promise<void> => {
    if (!aiPreview) return;
    const nextIndex = aiPreview.triedIndex + 1;
    if (nextIndex >= aiPreview.allIds.length) return;
    const nextId = aiPreview.allIds[nextIndex];
    const nextProduct = rows.find((r) => r.id === nextId);
    setIsApplyingAi(true);
    try {
      const response = await apiFetch<{ jobId: string }>('/ai/apply', {
        method: 'POST',
        body: JSON.stringify({
          fieldDefinitionId: aiFieldId,
          promptTemplate: aiPrompt,
          webSearch: aiUseWebSearch || validCompetitorUrls.length > 0,
          competitorUrls: validCompetitorUrls,
          sourceIds: selectedSourceIds,
          sourcesOnly,
          rows: [{ ownerType: 'product', ownerId: nextId }],
        }),
      });
      setAiPreview((prev) => prev ? {
        ...prev,
        triedIndex: nextIndex,
        previewJobId: response.jobId,
        previewResult: null,
        previewProductTitle: nextProduct?.title ?? nextId,
      } : null);
    } catch {
      setMessage('Kunne ikke starte AI preview for næste produkt.');
    } finally {
      setIsApplyingAi(false);
    }
  };

  const approveAndRunRest = async (): Promise<void> => {
    if (!aiPreview) return;
    const remainingIds = aiPreview.allIds.slice(aiPreview.triedIndex + 1);
    setAiPreview(null);
    if (!remainingIds.length) {
      setMessage('Preview gennemført — ingen yderligere produkter at køre batch på.');
      return;
    }
    const usesWebSearch = aiUseWebSearch || validCompetitorUrls.length > 0;
    if (usesWebSearch && remainingIds.length > 1) {
      setPendingBulkWebSearchIds(remainingIds);
      return;
    }
    await startBulkRun(remainingIds);
  };

  const startBulkRun = async (remainingIds: string[]): Promise<void> => {
    setIsApplyingAi(true);
    try {
      const response = await apiFetch<{ jobId: string }>('/ai/apply', {
        method: 'POST',
        body: JSON.stringify({
          fieldDefinitionId: aiFieldId,
          promptTemplate: aiPrompt,
          webSearch: aiUseWebSearch || validCompetitorUrls.length > 0,
          competitorUrls: validCompetitorUrls,
          sourceIds: selectedSourceIds,
          sourcesOnly,
          notifyEmail: aiNotifyEmail || null,
          rows: remainingIds.map((id) => ({ ownerType: 'product', ownerId: id })),
        }),
      });
      registerBackgroundActivityJobs([response.jobId]);
      setActiveAiBatchJobId(response.jobId);
      setMessage(`AI batch startet for ${remainingIds.length} ${remainingIds.length === 1 ? 'produkt' : 'produkter'}. Følg status i Baggrundsaktivitet.`);
    } catch {
      setMessage('Kunne ikke starte AI batch for resterende produkter.');
    } finally {
      setIsApplyingAi(false);
    }
  };

  const cancelAiBatch = async (): Promise<void> => {
    if (!activeAiBatchJobId) return;
    try {
      await apiFetch<{ ok: boolean }>(`/ai/jobs/${activeAiBatchJobId}/cancel`, { method: 'POST' });
      setActiveAiBatchJobId(null);
      setMessage('AI-generering stoppet.');
    } catch {
      setMessage('Kunne ikke stoppe AI-generering.');
    }
  };

  // Evaluate quality rules for a product row
  const evaluateQuality = (product: Product): { errors: number; warnings: number } => {
    let errors = 0;
    let warnings = 0;
    for (const rule of qualityRules.filter((r) => r.active)) {
      let fieldValue = '';
      if (rule.field === '_title') fieldValue = product.title ?? '';
      else if (rule.field === '_description') fieldValue = (product as any).descriptionHtml ?? '';
      else if (rule.field === '_sku') fieldValue = product.variants?.[0]?.sku ?? '';
      else {
        const fv = product.fieldValues?.find((f) => f.fieldDefinition.key === rule.field);
        fieldValue = fv ? String(fv.valueJson ?? '') : '';
      }

      let violated = false;
      if (rule.operator === 'not_empty') violated = !fieldValue.trim();
      else if (rule.operator === 'min_length') violated = fieldValue.trim().length < Number(rule.value ?? 0);
      else if (rule.operator === 'max_length') violated = fieldValue.trim().length > Number(rule.value ?? 999999);
      else if (rule.operator === 'has_image') violated = (product.imagesJson?.length ?? 0) === 0;
      else if (rule.operator === 'not_null_sku') violated = !(product.variants?.every((v) => v.sku));

      if (violated) {
        if (rule.severity === 'error') errors++;
        else warnings++;
      }
    }
    return { errors, warnings };
  };

  const runAltTextBulk = async (): Promise<void> => {
    let ids: string[];
    if (allProductsSelected && onFetchAllForBulk) {
      try { const all = await onFetchAllForBulk(); ids = all.map((p) => p.id); }
      catch { toast.error('Kunne ikke hente alle produkter.'); return; }
    } else {
      ids = selectedProductIds;
    }
    if (!ids.length) { toast.error('Vælg mindst ét produkt.'); return; }
    setAltTextRunning(true);
    try {
      const resp = await apiFetch<{ jobId: string }>('/ai/alt-text/bulk', {
        method: 'POST',
        body: JSON.stringify({ productIds: ids, notifyEmail: altTextNotifyEmail || null }),
      });
      registerBackgroundActivityJobs([resp.jobId]);
      setAltTextJobId(resp.jobId);
      setAltTextModalOpen(false);
      toast.success(`Alt-tekst generering startet for ${ids.length} produkter.`);
    } catch { toast.error('Kunne ikke starte alt-tekst generering.'); }
    finally { setAltTextRunning(false); }
  };

  const syncAllPending = async (): Promise<void> => {
    if (!serverPendingCount) return;
    setIsSyncingPending(true);
    const timeout = setTimeout(() => setIsSyncingPending(false), 30000);
    try {
      const controller = new AbortController();
      const abortTimeout = setTimeout(() => controller.abort(), 25000);
      const response = await apiFetch<{ queued: number; syncJobIds: string[] }>('/products/sync-pending', {
        method: 'POST',
        signal: controller.signal,
      });
      clearTimeout(abortTimeout);
      if (response.syncJobIds.length) {
        registerBackgroundActivityJobs(response.syncJobIds);
      }
      setMessage(`${response.queued} produkter sendt til Shopify sync-køen.`);
    } catch {
      setMessage('Kunne ikke starte synkronisering. Prøv igen om lidt.');
    } finally {
      clearTimeout(timeout);
      setIsSyncingPending(false);
    }
  };
  const totalRows = total;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const startIndex = totalRows === 0 ? 0 : (page - 1) * pageSize + 1;
  const endIndex = Math.min(page * pageSize, totalRows);
  


  const updatePendingField = useCallback((
    productId: string,
    field: 'title' | 'handle',
    nextValue: string,
    originalValue: string,
  ): void => {
    setPending((prev) => {
      const currentPatch = { ...(prev[productId] ?? {}) };
      if (nextValue === originalValue) {
        delete currentPatch[field];
      } else {
        currentPatch[field] = nextValue;
      }

      if (Object.keys(currentPatch).length === 0) {
        const cloned = { ...prev };
        delete cloned[productId];
        return cloned;
      }

      return {
        ...prev,
        [productId]: currentPatch,
      };
    });
  }, []);

  // Auto-save drafts: debounce 2s after pending changes
  useEffect(() => {
    const entries = Object.entries(pending);
    if (entries.length === 0) return;
    const timeoutId = setTimeout(() => {
      for (const [productId, patch] of entries) {
        if (Object.keys(patch).length > 0) {
          apiFetch('/drafts', {
            method: 'PUT',
            body: JSON.stringify({ entityType: 'product', entityId: productId, patchJson: patch }),
          }).then(() => {
            setRows((prev) => prev.map((r) => r.id === productId ? { ...r, hasDraft: true, syncStatus: 'kladde' } : r));
          }).catch(() => { /* silent fail for draft save */ });
        }
      }
    }, 2000);
    return () => clearTimeout(timeoutId);
  }, [pending]);

  // Poll for AI preview job completion
  useEffect(() => {
    if (!aiPreview?.previewJobId) return;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const status = await apiFetch<{ jobs: Array<{ id: string; status: string; error?: string | null }> }>('/sync-jobs/status', {
          method: 'POST',
          body: JSON.stringify({ jobIds: [aiPreview.previewJobId] }),
        });
        if (cancelled) return;
        const job = status.jobs[0];
        if (!job) return;
        if (job.status === 'done') {
          const productId = aiPreview.allIds[aiPreview.triedIndex];
          const productResponse = await apiFetch<{ product: { fieldValues?: Array<{ fieldDefinitionId: string; valueJson: unknown }> } }>(`/products/${productId}`);
          if (cancelled) return;
          const fieldValue = productResponse.product.fieldValues?.find((fv) => fv.fieldDefinitionId === aiFieldId)?.valueJson;
          setAiPreview((prev) => prev ? { ...prev, previewResult: fieldValue == null ? '' : String(fieldValue), previewJobId: null } : null);
          setMessage('');
        } else if (job.status === 'failed') {
          setMessage(job.error ?? 'AI preview fejlede.');
          setAiPreview(null);
        }
      } catch { /* silent */ }
    };
    void poll();
    const intervalId = setInterval(() => void poll(), 1500);
    return () => { cancelled = true; clearInterval(intervalId); };
  }, [aiPreview?.previewJobId, aiPreview?.allIds, aiPreview?.triedIndex, aiFieldId]);

  const columns = useMemo<ColumnDef<Product>[]>(
    () => {
      const pimSyncColumn: ColumnDef<Product> = {
        id: 'pimSync',
        accessorFn: (row) => row.syncStatus ?? 'nuværende',
        header: () => (
          <div className="group relative inline-flex items-center gap-1 cursor-default">
            <span>Status</span>
            <svg viewBox="0 0 24 24" className="h-3 w-3 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
            <div className="pointer-events-none absolute left-0 top-full z-[60] mt-1 w-52 rounded-lg border border-slate-200 bg-white p-2.5 text-[11px] text-slate-600 shadow-xl opacity-0 transition group-hover:opacity-100 font-normal normal-case tracking-normal whitespace-normal">
              Synkroniseringsstatus mellem ePIM og Shopify for dette produkt.
            </div>
          </div>
        ),
        meta: { label: 'Status' },
        size: 80,
        minSize: 80,
        maxSize: 80,
        enableResizing: false,
        cell: ({ row }) => {
          const hasPendingInGrid = Boolean(pending[row.original.id]);
          const serverStatus = row.original.syncStatus ?? 'nuværende';
          const hasDraft = row.original.hasDraft;

          if (hasPendingInGrid) {
            return (
              <span title="Redigeret lokalt — ikke gemt endnu" className="flex justify-center text-amber-500">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              </span>
            );
          }
          if (serverStatus === 'konflikt') {
            return (
              <span title="Konflikt — både PIM og Shopify ændret samtidig" className="flex justify-center text-red-500">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              </span>
            );
          }
          if (serverStatus === 'kladde' || hasDraft) {
            return (
              <span title="Kladde — ændringer ikke sendt til Shopify endnu" className="flex justify-center text-violet-500">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              </span>
            );
          }
          if (serverStatus === 'afventer_sync') {
            return (
              <span title="Afventer synkronisering til Shopify" className="flex justify-center text-orange-500">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              </span>
            );
          }
          if (serverStatus === 'forældet') {
            return (
              <span title="Shopify har nyere data — ikke hentet til PIM endnu" className="flex justify-center text-sky-500">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              </span>
            );
          }
          // nuværende — in sync
          return (
            <span title="I sync — PIM og Shopify er identiske" className="flex justify-center text-emerald-500">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            </span>
          );
        },
      };

      const selectColumn: ColumnDef<Product> = {
        id: 'select',
        header: () => (
          <input
            type="checkbox"
            className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            checked={allVisibleSelected}
            onChange={toggleSelectAllVisible}
            aria-label="Vælg alle viste produkter"
          />
        ),
        size: 36,
        minSize: 36,
        maxSize: 36,
        enableResizing: false,
        enableHiding: false,
        cell: ({ row }) => (
          <input
            type="checkbox"
            className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            checked={selectedProductIds.includes(row.original.id)}
            onChange={() => toggleSelectProduct(row.original.id)}
            aria-label={`Vælg produkt ${row.original.title}`}
          />
        ),
      };

      const thumbnailColumn: ColumnDef<Product> = {
        id: 'thumbnail',
        header: '',
        size: 44,
        minSize: 44,
        maxSize: 44,
        enableResizing: false,
        enableHiding: false,
        enableSorting: false,
        cell: ({ row }) => {
          const img = (row.original.imagesJson ?? [])[0];
          if (!img) {
            return (
              <div className="h-8 w-8 rounded-lg border border-slate-200 bg-slate-50 flex items-center justify-center">
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-slate-300" fill="none" stroke="currentColor" strokeWidth="1.5"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="m3 9 6-6 6 6 3-3 3 3"/><circle cx="8.5" cy="8.5" r="1.5"/></svg>
              </div>
            );
          }
          return (
            <img
              src={img.url}
              alt={img.altText ?? ''}
              className="h-8 w-8 rounded-lg border border-slate-200 object-cover"
            />
          );
        },
      };

      const goColumn: ColumnDef<Product> = {
        id: 'go',
        header: '',
        size: 32,
        minSize: 32,
        maxSize: 32,
        enableResizing: false,
        enableHiding: false,
        enableSorting: false,
        cell: () => (
          <span className="flex justify-center opacity-0 group-hover:opacity-100 transition-opacity text-indigo-400">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m9 18 6-6-6-6"/></svg>
          </span>
        ),
      };

      const baseColumns: ColumnDef<Product>[] = [
        {
          id: 'title',
          accessorKey: 'title',
          header: 'Titel',
          size: 240,
          minSize: 160,
          maxSize: 460,
          cell: ({ row, getValue }) => {
            const originalValue = String(getValue() ?? '');
            return (
              <input
                key={`title-${row.original.id}-${row.original.title}`}
                className="w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-sm text-slate-800 hover:border-slate-200 focus:border-indigo-300 focus:bg-white focus:ring-2 focus:ring-indigo-100 transition"
                defaultValue={originalValue}
                onBlur={(event) =>
                  updatePendingField(row.original.id, 'title', event.target.value, originalValue)
                }
              />
            );
          },
        },
        {
          id: 'handle',
          accessorKey: 'handle',
          header: 'Handle',
          size: 160,
          minSize: 120,
          maxSize: 320,
          cell: ({ row, getValue }) => {
            const originalValue = String(getValue() ?? '');
            return (
              <input
                key={`handle-${row.original.id}-${row.original.handle}`}
                className="w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-xs text-slate-600 font-mono hover:border-slate-200 focus:border-indigo-300 focus:bg-white focus:ring-2 focus:ring-indigo-100 transition"
                defaultValue={originalValue}
                onBlur={(event) =>
                  updatePendingField(row.original.id, 'handle', event.target.value, originalValue)
                }
              />
            );
          },
        },
        { id: 'vendor', accessorKey: 'vendor', header: 'Leverandør', size: 140, minSize: 100, maxSize: 280 },
        { id: 'productType', accessorKey: 'productType', header: 'Produkttype', size: 130, minSize: 90, maxSize: 240,
          cell: ({ getValue }) => { const v = getValue(); return v ? <span className="text-slate-700">{String(v)}</span> : <span className="text-slate-400">—</span>; },
        },
        {
          id: 'barcode',
          header: 'Barcode / EAN',
          meta: { label: 'Barcode / EAN', group: 'variant' },
          accessorFn: (row) => (row.variants ?? []).map((v) => v.barcode).filter(Boolean).join(', '),
          enableSorting: false,
          size: 150,
          minSize: 110,
          maxSize: 220,
          cell: ({ row }) => {
            const barcodes = (row.original.variants ?? [])
              .map((v) => v.barcode)
              .filter((b): b is string => Boolean(b));
            const unique = [...new Set(barcodes)];
            if (!unique.length) return <span className="text-slate-400">—</span>;
            return (
              <span className="font-mono text-xs text-slate-700 tabular-nums">
                {unique[0]}{unique.length > 1 && <span className="ml-1 text-slate-400">+{unique.length - 1}</span>}
              </span>
            );
          },
        },
        {
          id: 'totalInventory',
          header: 'Lager',
          meta: { label: 'Lager', group: 'variant' },
          accessorFn: (row) => (row.variants ?? []).reduce((sum, v) => sum + (v.inventoryQuantity ?? 0), 0),
          size: 90,
          minSize: 70,
          maxSize: 140,
          cell: ({ row }) => {
            const total = (row.original.variants ?? []).reduce((sum, v) => sum + (v.inventoryQuantity ?? 0), 0);
            const hasData = (row.original.variants ?? []).some((v) => v.inventoryQuantity != null);
            if (!hasData) return <span className="text-slate-400">—</span>;
            return <span className="tabular-nums text-slate-800">{total.toLocaleString('da-DK')}</span>;
          },
        },
        {
          id: 'sku',
          header: 'SKU',
          meta: { label: 'SKU', group: 'variant' },
          accessorFn: (row) => (row.variants ?? [])[0]?.sku ?? '',
          enableSorting: false,
          size: 130,
          minSize: 90,
          maxSize: 240,
          cell: ({ row }) => {
            const sku = (row.original.variants ?? [])[0]?.sku;
            const count = (row.original.variants ?? []).filter((v) => v.sku).length;
            if (!sku) return <span className="text-slate-400">—</span>;
            return (
              <span className="font-mono text-xs text-slate-700">
                {sku}{count > 1 && <span className="ml-1 text-slate-400">+{count - 1}</span>}
              </span>
            );
          },
        },
        {
          id: 'hsCode',
          header: 'HS-kode',
          meta: { label: 'HS-kode', group: 'variant' },
          accessorFn: (row) => (row.variants ?? [])[0]?.hsCode ?? '',
          enableSorting: false,
          size: 120,
          minSize: 90,
          maxSize: 200,
          cell: ({ row }) => {
            const val = (row.original.variants ?? [])[0]?.hsCode;
            return val
              ? <span className="font-mono text-xs text-slate-700">{val}</span>
              : <span className="text-slate-400">—</span>;
          },
        },
        {
          id: 'countryOfOrigin',
          header: 'Oprindelse',
          meta: { label: 'Oprindelse', group: 'variant' },
          accessorFn: (row) => (row.variants ?? [])[0]?.countryOfOrigin ?? '',
          enableSorting: false,
          size: 110,
          minSize: 80,
          maxSize: 160,
          cell: ({ row }) => {
            const val = (row.original.variants ?? [])[0]?.countryOfOrigin;
            return val
              ? <span className="font-mono text-xs text-slate-700 uppercase">{val}</span>
              : <span className="text-slate-400">—</span>;
          },
        },
        {
          id: 'shopifySync',
          header: 'Shopify-sync',
          accessorFn: (row) => row.syncStatus ?? 'nuværende',
          size: 175,
          minSize: 120,
          maxSize: 280,
          cell: ({ row }) => {
            const hasPendingInGrid = Boolean(pending[row.original.id]);
            const serverStatus = row.original.syncStatus ?? 'nuværende';
            const hasDraft = row.original.hasDraft;

            if (hasPendingInGrid) {
              return (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                  Redigeret (lokal)
                </span>
              );
            }
            if (serverStatus === 'kladde' || hasDraft) {
              return (
                <div className="flex items-center gap-1.5">
                  <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-700">
                    <span className="h-1.5 w-1.5 rounded-full bg-violet-500" />
                    Kladde
                  </span>
                  <button
                    className="text-[10px] text-emerald-600 hover:text-emerald-800 underline"
                    onClick={async (e) => {
                      e.stopPropagation();
                      try {
                        const res = await apiFetch<{ syncJobId: string }>(`/drafts/product/${row.original.id}/commit`, { method: 'POST' });
                        setRows((prev) => prev.map((r) => r.id === row.original.id ? { ...r, hasDraft: false, syncStatus: 'afventer_sync' } : r));
                        if (res.syncJobId) registerBackgroundActivityJobs([res.syncJobId]);
                        setMessage('Kladde commitet og sendt til Shopify.');
                      } catch { setMessage('Kunne ikke synkronisere kladde.'); }
                    }}
                  >
                    Synk
                  </button>
                  <button
                    className="text-[10px] text-red-500 hover:text-red-700 underline"
                    onClick={async (e) => {
                      e.stopPropagation();
                      try {
                        await apiFetch(`/drafts/product/${row.original.id}`, { method: 'DELETE' });
                        setPending((prev) => { const next = { ...prev }; delete next[row.original.id]; return next; });
                        setRows((prev) => prev.map((r) => r.id === row.original.id ? { ...r, hasDraft: false, syncStatus: 'nuværende' } : r));
                        setMessage('Kladde kasseret.');
                      } catch { setMessage('Kunne ikke kassere kladde.'); }
                    }}
                  >
                    Kassér
                  </button>
                </div>
              );
            }
            if (serverStatus === 'konflikt') {
              return (
                <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
                  Konflikt
                </span>
              );
            }
            if (serverStatus === 'afventer_sync') {
              return (
                <span className="inline-flex items-center gap-1 rounded-full bg-orange-100 px-2 py-0.5 text-[11px] font-medium text-orange-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-orange-500" />
                  Afventer Shopify
                </span>
              );
            }
            if (serverStatus === 'forældet') {
              return (
                <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-medium text-sky-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-sky-500" />
                  Forældet
                </span>
              );
            }
            return (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                Nuværende
              </span>
            );
          },
        },
        {
          id: 'status',
          accessorKey: 'status',
          header: 'Status',
          size: 110,
          minSize: 80,
          maxSize: 220,
          cell: ({ getValue }) => {
            const val = getValue();
            if (!val) return <span className="text-slate-400">–</span>;
            return <StatusBadge status={String(val)} />;
          },
        },
        {
          id: 'lastShopifySyncAt',
          accessorKey: 'lastShopifySyncAt',
          header: () => (
            <div className="group relative inline-flex items-center gap-1 cursor-default">
              <span>Seneste Shopify-sync</span>
              <svg viewBox="0 0 24 24" className="h-3 w-3 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
              <div className="pointer-events-none absolute left-0 top-full z-[60] mt-1 w-60 rounded-lg border border-slate-200 bg-white p-2.5 text-[11px] text-slate-600 shadow-xl opacity-0 transition group-hover:opacity-100 font-normal normal-case tracking-normal whitespace-normal">
                Tidspunkt for seneste gang ePIM har skrevet data til Shopify for dette produkt. Sorter stigende for at finde produkter, der aldrig eller sjældent er synkroniseret.
              </div>
            </div>
          ),
          meta: { label: 'Seneste Shopify-sync' },
          size: 170,
          minSize: 130,
          maxSize: 260,
          cell: ({ getValue }) => {
            const val = getValue();
            if (!val) {
              return (
                <span className="inline-flex items-center gap-1 text-slate-400 text-xs">
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-slate-300" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M4.93 4.93l14.14 14.14"/></svg>
                  Aldrig synkroniseret
                </span>
              );
            }
            const date = new Date(String(val));
            const now = new Date();
            const diffMs = now.getTime() - date.getTime();
            const diffDays = Math.floor(diffMs / 86400000);
            const diffHours = Math.floor(diffMs / 3600000);
            const diffMins = Math.floor(diffMs / 60000);
            let relativeLabel: string;
            if (diffMins < 2) relativeLabel = 'Lige nu';
            else if (diffMins < 60) relativeLabel = `${diffMins} min. siden`;
            else if (diffHours < 24) relativeLabel = `${diffHours} t. siden`;
            else if (diffDays < 7) relativeLabel = `${diffDays} d. siden`;
            else relativeLabel = date.toLocaleDateString('da-DK', { day: 'numeric', month: 'short', year: diffDays > 365 ? 'numeric' : undefined });
            const fullLabel = date.toLocaleString('da-DK', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            return (
              <span className="inline-flex items-center gap-1 text-xs text-slate-600" title={fullLabel}>
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-emerald-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                {relativeLabel}
              </span>
            );
          },
        },
        {
          id: 'createdVia',
          accessorKey: 'createdVia',
          header: 'Oprindelse',
          meta: { label: 'Oprindelse' },
          size: 140,
          minSize: 110,
          maxSize: 200,
          cell: ({ row }) => {
            const via = row.original.createdVia ?? 'shopify';
            const createdAt = row.original.createdAt;
            const dateStr = createdAt
              ? new Date(createdAt).toLocaleDateString('da-DK', { day: 'numeric', month: 'short', year: 'numeric' })
              : null;
            if (via === 'epim') {
              return (
                <div className="flex flex-col gap-0.5">
                  <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 border border-indigo-200 px-2 py-0.5 text-[11px] font-medium text-indigo-700">
                    <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                    ePIM
                  </span>
                  {dateStr && <span className="text-[10px] text-slate-400 pl-1">{dateStr}</span>}
                </div>
              );
            }
            if (via === 'import') {
              return (
                <div className="flex flex-col gap-0.5">
                  <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 border border-slate-200 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                    <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    Import
                  </span>
                  {dateStr && <span className="text-[10px] text-slate-400 pl-1">{dateStr}</span>}
                </div>
              );
            }
            return (
              <div className="flex flex-col gap-0.5">
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                  <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                  Shopify
                </span>
                {dateStr && <span className="text-[10px] text-slate-400 pl-1">{dateStr}</span>}
              </div>
            );
          },
        },
      ];

      const customColumns: ColumnDef<Product>[] = fields.filter((field) => field.key !== '_title' && field.key !== '_description').map((field) => ({
        id: `field-${field.id}`,
        header: field.label,
        accessorFn: (row: Product) => {
          const v = row.fieldValues?.find((fv) => fv.fieldDefinition.id === field.id)?.valueJson;
          return v != null ? String(v) : '';
        },
        size: 260,
        minSize: 140,
        maxSize: 560,
        cell: ({ row }) => {
          const value = row.original.fieldValues?.find((fieldValue) => fieldValue.fieldDefinition.id === field.id)?.valueJson;
          if (value == null) {
            return <span className="text-gray-400">—</span>;
          }
          const rawText = typeof value === 'string' ? value : JSON.stringify(value);
          if (field.type === 'html' && typeof value === 'string') {
            const plain = value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            if (!plain) {
              return <span className="text-gray-400">—</span>;
            }
            return (
              <div className="group/cell relative max-w-[280px]">
                <span className="block truncate text-gray-800" title={plain}>{plain}</span>
                <div className="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden w-[420px] max-w-[70vw] rounded-lg border border-gray-200 bg-white p-2 text-xs text-gray-700 shadow-xl group-hover/cell:block">
                  <div className="max-h-56 overflow-auto whitespace-pre-wrap break-words">{plain}</div>
                </div>
              </div>
            );
          }
          return (
            <div className="group/cell relative max-w-[280px]">
              <span className="block truncate text-gray-800" title={rawText}>{rawText}</span>
              <div className="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden w-[420px] max-w-[70vw] rounded-lg border border-gray-200 bg-white p-2 text-xs text-gray-700 shadow-xl group-hover/cell:block">
                <div className="max-h-56 overflow-auto whitespace-pre-wrap break-words">{rawText}</div>
              </div>
            </div>
          );
        },
      }));

      // Expand column for inline variant editing
      const expandColumn: ColumnDef<Product> = {
        id: 'expand',
        header: () => <span>Var.</span>,
        meta: { label: 'Varianter', hideable: false },
        size: 52,
        minSize: 52,
        maxSize: 52,
        enableResizing: false,
        enableHiding: false,
        enableSorting: false,
        cell: ({ row }) => {
          const variantCount = row.original.variants?.length ?? 0;
          if (!variantCount) return null;
          const isExpanded = expandedProductIds.has(row.original.id);
          return (
            <button
              type="button"
              title={isExpanded ? 'Skjul varianter' : `Vis ${variantCount} variant${variantCount === 1 ? '' : 'er'}`}
              className={`flex items-center gap-1 px-1 py-0.5 rounded text-xs font-medium transition ${isExpanded ? 'text-indigo-600 bg-indigo-50' : 'text-slate-500 hover:text-indigo-600 hover:bg-indigo-50'}`}
              onClick={(e) => {
                e.stopPropagation();
                setExpandedProductIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(row.original.id)) next.delete(row.original.id);
                  else next.add(row.original.id);
                  return next;
                });
              }}
            >
              <svg viewBox="0 0 24 24" className={`h-3 w-3 transition-transform flex-shrink-0 ${isExpanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m9 18 6-6-6-6"/></svg>
              {variantCount}
            </button>
          );
        },
      };

      // Quality badge column (only if there are active rules)
      const activeRules = qualityRules.filter((r) => r.active);
      const qualityColumn: ColumnDef<Product> | null = activeRules.length > 0 ? {
        id: 'quality',
        header: () => <span title="Datakvalitet">DQ</span>,
        meta: { label: 'Datakvalitet' },
        size: 44,
        minSize: 44,
        maxSize: 44,
        enableResizing: false,
        enableSorting: false,
        cell: ({ row }) => {
          const { errors, warnings } = evaluateQuality(row.original);
          if (errors > 0) return <span title={`${errors} fejl`} className="flex justify-center"><span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-red-100 text-[10px] font-bold text-red-600">{errors}</span></span>;
          if (warnings > 0) return <span title={`${warnings} advarsler`} className="flex justify-center"><span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-amber-100 text-[10px] font-bold text-amber-600">{warnings}</span></span>;
          return <span className="flex justify-center"><span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-[10px] text-emerald-600">✓</span></span>;
        },
      } : null;

      const productFields = fields.filter((f) => f.scope === 'product');
      const completenessColumn: ColumnDef<Product> = {
        id: 'completeness',
        header: () => <span title="Datakomplethed">%</span>,
        meta: { label: 'Komplethed' },
        size: 52,
        minSize: 52,
        maxSize: 52,
        enableResizing: false,
        enableSorting: false,
        cell: ({ row }) => {
          const p = row.original;
          const checks = [
            Boolean(p.title?.trim()),
            Boolean(p.descriptionHtml?.replace(/<[^>]+>/g, '').trim()),
            Boolean(p.imagesJson && p.imagesJson.length > 0),
            Boolean(p.vendor?.trim()),
            Boolean(p.productType?.trim()),
            Boolean(p.variants?.[0]?.barcode?.trim()),
          ];
          for (const f of productFields) {
            const fv = p.fieldValues?.find((v) => v.fieldDefinition.key === f.key);
            checks.push(Boolean(fv && String(fv.valueJson ?? '').trim()));
          }
          const score = checks.length > 0 ? Math.round((checks.filter(Boolean).length / checks.length) * 100) : 0;
          const color = score >= 80 ? 'text-emerald-600 bg-emerald-50' : score >= 50 ? 'text-amber-600 bg-amber-50' : 'text-red-600 bg-red-50';
          return (
            <span className="flex justify-center">
              <span className={`inline-flex h-6 min-w-[26px] items-center justify-center rounded-full px-1 text-[10px] font-semibold ${color}`}>
                {score}
              </span>
            </span>
          );
        },
      };

      const allCols: ColumnDef<Product>[] = [expandColumn, selectColumn, thumbnailColumn, pimSyncColumn];
      if (qualityColumn) allCols.push(qualityColumn);
      allCols.push(completenessColumn, ...baseColumns, ...customColumns, goColumn);
      return allCols;
    },
    [
      allVisibleSelected,
      fields,
      pending,
      selectedProductIds,
      updatePendingField,
      qualityRules,
      expandedProductIds,
      evaluateQuality,
      rows,
    ],
  );

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    enableColumnResizing: true,
    columnResizeMode: 'onChange',
    state: {
      sorting,
      columnVisibility,
      columnSizing,
      columnOrder,
    },
    onSortingChange: onSortingChange,
    onColumnVisibilityChange: setColumnVisibility,
    onColumnSizingChange: setColumnSizing,
    onColumnOrderChange: setColumnOrder,
  });

  const exportCsv = (): void => setExportModalOpen(true);

  const savePendingChanges = async (): Promise<void> => {
    const products = Object.entries(pending).map(([id, patch]) => ({ id, patch }));
    if (!products.length) return;
    try {
      const response = await apiFetch<{ ok: boolean; syncJobIds?: string[] }>('/bulk/patch', {
        method: 'POST',
        body: JSON.stringify({ products, variants: [], syncNow: true }),
      });
      setRows((prev) =>
        prev.map((product) => ({
          ...product,
          ...(pending[product.id] ?? {}),
          hasDraft: pending[product.id] ? false : product.hasDraft,
          syncStatus: pending[product.id] ? 'afventer_sync' : product.syncStatus,
        })),
      );
      setPending({});
      if (response.syncJobIds?.length) {
        registerBackgroundActivityJobs(response.syncJobIds);
        setMessage('Ændringer gemt og sendt til Shopify sync-køen.');
      } else {
        setMessage('Ændringer gemt.');
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Kunne ikke gemme ændringer. Prøv igen.');
    }
  };

  return (
    <div className="space-y-4">
      {/* ── Web Search Bulk Warning Dialog ── */}
      {pendingBulkWebSearchIds && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-amber-200 bg-white shadow-2xl overflow-hidden">
            <div className="flex items-start gap-4 px-5 py-5 bg-amber-50 border-b border-amber-100">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-100">
                <svg viewBox="0 0 24 24" className="h-5 w-5 text-amber-600" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                  <path d="M12 9v4m0 4h.01"/>
                </svg>
              </div>
              <div>
                <p className="text-sm font-semibold text-amber-900">Web-søgning aktiveret på bulk-kørsel</p>
                <p className="text-xs text-amber-700 mt-0.5">
                  Du er ved at køre AI på <span className="font-semibold">{pendingBulkWebSearchIds.length} produkter</span> med <span className="font-semibold">web_search_preview</span> slået til.
                </p>
              </div>
            </div>
            <div className="px-5 py-4 space-y-3">
              <p className="text-sm text-slate-700">
                Hvert AI-kald med websøgning koster <span className="font-semibold">$0,025 pr. produkt</span> — uafhængigt af tokens.
              </p>
              <div className="rounded-xl bg-slate-50 border border-slate-200 px-4 py-3 space-y-1.5 text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-500">Antal produkter</span>
                  <span className="font-semibold text-slate-800">{pendingBulkWebSearchIds.length.toLocaleString('da-DK')}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Estimeret web search-omkostning</span>
                  <span className="font-semibold text-amber-700">
                    ~${(pendingBulkWebSearchIds.length * 0.025).toFixed(2)} USD
                    {' '}(~{(pendingBulkWebSearchIds.length * 0.025 * 6.9).toFixed(0)} kr)
                  </span>
                </div>
              </div>
              <p className="text-xs text-slate-400">Hertil kommer token-forbrug. Daglig spending cap gælder.</p>
            </div>
            <div className="flex gap-2 px-5 pb-5">
              <button
                onClick={() => setPendingBulkWebSearchIds(null)}
                className="ep-btn-secondary flex-1"
              >
                Annuller
              </button>
              <button
                onClick={() => { const ids = pendingBulkWebSearchIds; setPendingBulkWebSearchIds(null); void startBulkRun(ids); }}
                className="flex-1 inline-flex items-center justify-center rounded-xl bg-amber-500 px-3 py-2 text-sm font-medium text-white hover:bg-amber-600 transition"
              >
                Forstået — start alligevel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── AI Batch Preview Modal ── */}
      {aiPreview && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white shadow-2xl overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 bg-slate-50">
              <div>
                <p className="text-xs font-semibold text-indigo-600 uppercase tracking-wide mb-0.5">AI Forhåndsvisning</p>
                <p className="text-sm font-medium text-slate-800 truncate max-w-xs" title={aiPreview.previewProductTitle}>
                  {aiPreview.previewProductTitle}
                </p>
              </div>
              <span className="text-xs text-slate-400">
                {aiPreview.triedIndex + 1} / {aiPreview.allIds.length}
              </span>
            </div>

            {/* Body */}
            <div className="px-5 py-5 min-h-[120px] flex items-center justify-center">
              {aiPreview.previewResult === null ? (
                /* Loading */
                <div className="flex flex-col items-center gap-3 text-slate-500">
                  <svg className="h-7 w-7 animate-spin text-indigo-500" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                  <span className="text-sm">Genererer forhåndsvisning…</span>
                </div>
              ) : aiPreview.previewResult === '' ? (
                <p className="text-sm text-slate-400 italic">Tomt resultat</p>
              ) : aiUseHtmlOutput ? (
                <div
                  className="ep-richtext text-sm text-slate-700 leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: aiPreview.previewResult }}
                />
              ) : (
                <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{aiPreview.previewResult}</p>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between gap-2 px-5 py-4 border-t border-slate-100 bg-slate-50">
              <button
                className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 transition"
                onClick={() => setAiPreview(null)}
              >
                Annuller
              </button>
              <div className="flex items-center gap-2">
                <button
                  className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 transition disabled:opacity-40 disabled:cursor-not-allowed"
                  disabled={aiPreview.previewResult === null || aiPreview.triedIndex >= aiPreview.allIds.length - 1}
                  onClick={() => void tryAnotherProduct()}
                >
                  Prøv på et andet produkt
                </button>
                <button
                  className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 transition disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
                  disabled={aiPreview.previewResult === null}
                  onClick={() => void approveAndRunRest()}
                >
                  Godkend og kør på resten ({aiPreview.allIds.length - aiPreview.triedIndex - 1})
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center gap-2">
        {conflictCount > 0 && (
          <div className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700">
            <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
            {conflictCount} {conflictCount === 1 ? 'konflikt' : 'konflikter'}
          </div>
        )}
        {serverPendingCount > 0 && (
          <button
            className="inline-flex items-center gap-1.5 rounded-lg border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-medium text-orange-700 hover:bg-orange-100 disabled:opacity-60 transition"
            disabled={isSyncingPending}
            onClick={syncAllPending}
          >
            <span className="h-2 w-2 rounded-full bg-orange-400" />
            {isSyncingPending ? 'Synkroniserer...' : `Synk ${serverPendingCount} afventende`}
          </button>
        )}
        <div className="flex flex-col gap-1 flex-1 min-w-[200px] max-w-sm">
          <div className="relative">
            {isLoading ? (
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-indigo-400 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
            ) : (
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
              </svg>
            )}
            <input
              className="w-full rounded-lg border border-slate-200 bg-white pl-9 pr-16 py-2 text-sm placeholder:text-slate-400 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 transition"
              placeholder="Søg produkter..."
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
            />
            {query ? (
              <button
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-slate-200 transition"
                onClick={() => onQueryChange('')}
              >
                Ryd
              </button>
            ) : (
              <kbd className="absolute right-2 top-1/2 -translate-y-1/2 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-400 font-mono">/</kbd>
            )}
          </div>
          {query && !isLoading && (
            <div className="text-[11px] text-slate-500 px-1">
              {totalRows === 0 ? (
                <span className="text-slate-400">Ingen resultater for <span className="font-medium text-slate-600">"{query}"</span></span>
              ) : (
                <span><span className="font-medium text-slate-700">{totalRows.toLocaleString('da-DK')}</span> {totalRows === 1 ? 'resultat' : 'resultater'} for <span className="font-medium text-slate-600">"{query}"</span></span>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 ml-auto">

          {/* ── Auto-expand toggle ── */}
          <button
            onClick={toggleAutoExpand}
            title={autoExpand ? 'Kollaps alle varianter automatisk' : 'Vis alle varianter automatisk'}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition ${
              autoExpand
                ? 'border-indigo-300 bg-indigo-50 text-indigo-700 font-medium'
                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>
            </svg>
            <span className="hidden sm:inline">Vis varianter</span>
            {autoExpand && <span className="h-1.5 w-1.5 rounded-full bg-indigo-500 flex-shrink-0" />}
          </button>

          {/* ── Kolonnevisning dropdown ── */}
          <div className="relative" ref={columnDropdownRef}>
            <button
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 transition"
              onClick={() => setColumnDropdownOpen((prev) => !prev)}
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18"/>
              </svg>
              Kolonner
              <svg viewBox="0 0 24 24" className={`h-3 w-3 transition-transform ${columnDropdownOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2">
                <path d="m6 9 6 6 6-6"/>
              </svg>
            </button>
            {columnDropdownOpen && (
              <div className="absolute right-0 top-full z-30 mt-1 w-72 rounded-xl border border-slate-200 bg-white shadow-xl overflow-hidden">
                <div className="px-3 py-2 border-b border-slate-100 bg-slate-50">
                  <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Kolonnevisning</span>
                  <p className="text-[11px] text-slate-400 mt-0.5">Træk for at ændre rækkefølge</p>
                </div>
                <div className="max-h-96 overflow-y-auto py-1">
                  {(['product', 'variant'] as const).map((group) => {
                    const groupCols = table.getAllLeafColumns().filter((col) => {
                      if (col.id === 'select' || !col.getCanHide()) return false;
                      const g = (col.columnDef.meta as { group?: string } | undefined)?.group;
                      return group === 'variant' ? g === 'variant' : g !== 'variant';
                    });
                    if (groupCols.length === 0) return null;
                    return (
                      <div key={group}>
                        <div className="px-3 pt-2 pb-1">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                            {group === 'variant' ? 'Variantdata' : 'Produktdata'}
                          </span>
                        </div>
                        {groupCols.map((column) => {
                          const label = (column.columnDef.meta as { label?: string } | undefined)?.label
                            ?? (typeof column.columnDef.header === 'string' ? column.columnDef.header : column.id);
                          return (
                            <div
                              key={column.id}
                              draggable
                              onDragStart={() => setDragColumnId(column.id)}
                              onDragOver={(e) => e.preventDefault()}
                              onDrop={() => {
                                if (!dragColumnId || dragColumnId === column.id) return;
                                const currentOrder = columnOrder.length
                                  ? [...columnOrder]
                                  : table.getAllLeafColumns().map((c) => c.id);
                                const fromIdx = currentOrder.indexOf(dragColumnId);
                                const toIdx = currentOrder.indexOf(column.id);
                                if (fromIdx === -1 || toIdx === -1) return;
                                currentOrder.splice(fromIdx, 1);
                                currentOrder.splice(toIdx, 0, dragColumnId);
                                setColumnOrder(currentOrder);
                                setDragColumnId(null);
                              }}
                              className={`flex items-center gap-2 px-3 py-1.5 hover:bg-slate-50 cursor-grab active:cursor-grabbing transition ${
                                dragColumnId === column.id ? 'opacity-50 bg-indigo-50' : ''
                              }`}
                            >
                              <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-slate-300 flex-shrink-0" fill="currentColor">
                                <circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/>
                                <circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>
                                <circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/>
                              </svg>
                              <label className="flex items-center gap-2 flex-1 cursor-pointer text-sm text-slate-700">
                                <input
                                  type="checkbox"
                                  className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                                  checked={column.getIsVisible()}
                                  onChange={column.getToggleVisibilityHandler()}
                                />
                                {label}
                              </label>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
                <div className="border-t border-slate-100 px-3 py-2">
                  <button
                    className="text-xs text-indigo-600 hover:text-indigo-700"
                    onClick={() => {
                      setColumnVisibility({});
                      setColumnOrder([]);
                    }}
                  >
                    Nulstil kolonner
                  </button>
                </div>
              </div>
            )}
          </div>

          <details className="relative">
            <summary className="list-none cursor-pointer inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 transition">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>
              </svg>
              Import/Eksport
            </summary>
            <div className="absolute right-0 mt-1 w-48 rounded-xl border border-slate-200 bg-white shadow-lg z-10 overflow-hidden">
              <Link href="/imports" className="flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-slate-50 transition">
                <svg viewBox="0 0 24 24" className="h-4 w-4 text-slate-500" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/></svg>
                Importér
              </Link>
              <button className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-left hover:bg-slate-50 transition" onClick={exportCsv}>
                <svg viewBox="0 0 24 24" className="h-4 w-4 text-slate-500" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>
                Eksportér CSV
              </button>
            </div>
          </details>
        </div>
      </div>

      {/* ── AI Batch Modal ── */}
      {aiBatchPanelOpen && (
        <div className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
            onClick={() => { setAiBatchPanelOpen(false); setAiLaunching(false); }}
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
                <div className="text-sm font-semibold text-white">AI Batch-generering</div>
                <div className="text-xs text-indigo-200 truncate font-medium">
                  {fields.find((f) => f.id === aiFieldId)?.label ?? '—'} · {effectiveCount > 0 ? `${effectiveCount.toLocaleString('da-DK')} valgt` : `${rows.length} viste`}
                </div>
              </div>
              {isApplyingAi && (
                <span className="flex items-center gap-1.5 rounded-full bg-white/20 px-2.5 py-1 text-xs text-white shrink-0">
                  <span className="h-1.5 w-1.5 rounded-full bg-indigo-200 animate-pulse" />
                  Kører...
                </span>
              )}
              <button
                type="button"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white/70 hover:bg-white/20 hover:text-white transition"
                onClick={() => setAiBatchPanelOpen(false)}
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>

            {/* Scrollable body */}
            <div className="overflow-y-auto flex-1 px-5 py-4 space-y-5">

              {/* Field selector (unique to batch) */}
              <div>
                <label className="block text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-1.5">Felt der genereres til</label>
                <select
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm focus:border-indigo-300 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-100 transition"
                  value={aiFieldId}
                  onChange={(e) => setAiFieldId(e.target.value)}
                >
                  {fields.filter((f) => f.scope === 'product').map((f) => (
                    <option key={f.id} value={f.id}>{f.label}</option>
                  ))}
                </select>
              </div>

              {/* Quick presets */}
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-2">Hurtig-preset</div>
                <div className="flex flex-wrap gap-1.5">
                  {quickPresets.map((preset) => {
                    const isActive = aiInstruction === preset.instruction;
                    return (
                      <button
                        key={preset.label}
                        type="button"
                        className={`rounded-full border px-3 py-1 text-xs font-medium active:scale-95 transition-all ${isActive ? 'border-indigo-500 bg-indigo-600 text-white' : 'border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100'}`}
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
                    <span className="text-xs font-medium text-gray-600">HTML output</span>
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
                  <input
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:border-indigo-300 focus:bg-white focus:outline-none transition"
                    value={aiKeywords}
                    onChange={(e) => setAiKeywords(e.target.value)}
                    placeholder="fx led spot, GU10"
                  />
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
                          <label key={source.id} className="flex items-center gap-2 cursor-pointer select-none group/src">
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
                            <span className="text-xs text-gray-700 group-hover/src:text-gray-900 transition">{source.name}</span>
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
                  <div>
                    <label className="text-xs font-medium text-gray-500">Konkurrent-links (én pr. linje)</label>
                    <textarea
                      className="mt-1 w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:border-indigo-300 focus:bg-white focus:outline-none transition"
                      rows={2}
                      value={competitorLinksInput}
                      onChange={(e) => setCompetitorLinksInput(e.target.value)}
                      placeholder={'greenline.dk\nwattoo.dk'}
                    />
                    {validCompetitorUrls.length > 0 && (
                      <div className="mt-1 text-[11px] text-gray-400">
                        Domæner: {validCompetitorUrls.map((url) => domainFromUrl(url)).join(', ')}
                      </div>
                    )}
                  </div>
                  {recentCompetitorLinks.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {recentCompetitorLinks.map((url) => (
                        <button
                          key={url}
                          type="button"
                          className="rounded-md bg-slate-100 px-2 py-1 text-[11px] text-slate-600 hover:bg-indigo-100 transition"
                          onClick={() =>
                            setCompetitorLinksInput((prev) => {
                              const lines = prev.split('\n').map((line) => line.trim()).filter(Boolean);
                              if (lines.includes(url)) return prev;
                              return [...lines, url].join('\n');
                            })
                          }
                        >
                          + {url}
                        </button>
                      ))}
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
                    <summary className="cursor-pointer text-gray-400 hover:text-gray-600 select-none">Vis prompt (debug)</summary>
                    <textarea className="mt-1.5 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs" rows={5} readOnly value={aiPrompt} />
                  </details>
                </div>
              </details>
            </div>

            {/* Email notification */}
            <div className="px-5 pb-3">
              <label className="flex items-center gap-2 text-xs text-gray-500">
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-gray-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                <span className="shrink-0">Send notifikation til:</span>
                <input
                  type="email"
                  className="flex-1 min-w-0 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1 text-xs focus:border-indigo-300 focus:outline-none transition"
                  placeholder="din@email.dk (valgfrit)"
                  value={aiNotifyEmail}
                  onChange={(e) => setAiNotifyEmail(e.target.value)}
                />
              </label>
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
                className="flex items-center justify-center gap-2 rounded-xl border border-indigo-200 bg-white px-4 py-2.5 text-sm font-semibold text-indigo-700 hover:bg-indigo-50 active:scale-[0.98] disabled:opacity-60 transition-all"
                disabled={isApplyingAi || effectiveCount === 0 || !aiFieldId}
                onClick={() => {
                  setAiLaunching(true);
                  setTimeout(() => {
                    setAiLaunching(false);
                    setAiBatchPanelOpen(false);
                    void runAiBatch('selected');
                  }, 700);
                }}
              >
                {isApplyingAi ? (
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="60" strokeLinecap="round"/></svg>
                ) : (
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
                )}
                Kør på valgte ({effectiveCount.toLocaleString('da-DK')})
              </button>
              <button
                type="button"
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 active:scale-[0.98] disabled:opacity-60 transition-all"
                disabled={isApplyingAi || rows.length === 0 || !aiFieldId}
                onClick={() => {
                  setAiLaunching(true);
                  setTimeout(() => {
                    setAiLaunching(false);
                    setAiBatchPanelOpen(false);
                    void runAiBatch('visible');
                  }, 700);
                }}
              >
                {isApplyingAi ? (
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="60" strokeLinecap="round"/></svg>
                ) : (
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
                )}
                Kør på alle viste ({rows.length})
              </button>
              {activeAiBatchJobId && !isApplyingAi && (
                <button
                  type="button"
                  onClick={() => void cancelAiBatch()}
                  className="rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm font-medium text-red-600 hover:bg-red-100 transition"
                >
                  ⬛ Stop
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {message && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700 flex items-center gap-2">
          <svg viewBox="0 0 24 24" className="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="m12 8v4"/><path d="m12 16h.01"/></svg>
          {message}
        </div>
      )}

      {allVisibleSelected && total > rows.length && (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-800 flex items-center justify-between gap-2">
          {allProductsSelected ? (
            <>
              <span>Alle <strong>{total.toLocaleString('da-DK')}</strong> produkter er valgt.</span>
              <button className="text-indigo-600 hover:underline text-xs font-medium" onClick={() => { setAllProductsSelected(false); setSelectedProductIds([]); }}>Fravælg alle</button>
            </>
          ) : (
            <>
              <span>Alle <strong>{rows.length}</strong> produkter på denne side er valgt.</span>
              <button className="text-indigo-600 hover:underline text-xs font-medium" onClick={() => setAllProductsSelected(true)}>Vælg alle {total.toLocaleString('da-DK')} produkter</button>
            </>
          )}
        </div>
      )}

      {/* ── Data Grid ── */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table-fixed bg-white" style={{ width: table.getTotalSize() }}>
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id} className="border-b border-slate-200 bg-slate-50/80">
                  {headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      style={{ width: header.getSize() }}
                      className="relative px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500"
                    >
                      {header.column.getCanSort() ? (
                        <button
                          className="inline-flex items-center gap-1 hover:text-slate-800 transition-colors select-none"
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {header.column.getIsSorted() === 'asc' && (
                            <svg viewBox="0 0 24 24" className="h-3 w-3 text-indigo-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m18 15-6-6-6 6"/></svg>
                          )}
                          {header.column.getIsSorted() === 'desc' && (
                            <svg viewBox="0 0 24 24" className="h-3 w-3 text-indigo-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m6 9 6 6 6-6"/></svg>
                          )}
                          {!header.column.getIsSorted() && (
                            <svg viewBox="0 0 24 24" className="h-3 w-3 text-slate-300 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" fill="none" stroke="currentColor" strokeWidth="2"><path d="m8 9 4-4 4 4M8 15l4 4 4-4"/></svg>
                          )}
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                      {header.column.getCanResize() && (
                        <div
                          onMouseDown={header.getResizeHandler()}
                          onTouchStart={header.getResizeHandler()}
                          className="absolute right-0 top-0 h-full w-1 cursor-col-resize select-none touch-none bg-transparent hover:bg-indigo-300 transition-colors"
                        />
                      )}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody className="divide-y divide-slate-100">
              {table.getRowModel().rows.map((row) => {
                const isDirty = Boolean(pending[row.original.id]);
                const isExpanded = expandedProductIds.has(row.original.id);
                return (
                  <React.Fragment key={row.id}>
                    <tr
                      className={`group transition-colors cursor-pointer ${isDirty ? 'bg-amber-50/50 hover:bg-amber-50' : isExpanded ? 'bg-indigo-50/20' : 'hover:bg-indigo-50/30'}`}
                      onClick={(e) => {
                        const target = e.target as HTMLElement;
                        if (target.closest('input, button, a, select, textarea')) return;
                        void router.push(`/products/${row.original.id}`);
                      }}
                    >
                      {row.getVisibleCells().map((cell, cellIndex) => (
                        <td
                          key={cell.id}
                          style={{ width: cell.column.getSize() }}
                          className={`px-2.5 py-1.5 text-sm text-slate-700 align-middle ${
                            isDirty && cellIndex === 0
                              ? 'border-l-2 border-l-amber-400'
                              : ''
                          }`}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                    {isExpanded && (row.original.variants ?? []).map((v) => (
                      <VariantTableRow
                        key={`${row.id}-v-${v.id}`}
                        variant={v}
                        visibleColumns={table.getVisibleLeafColumns()}
                        onSave={(patch) =>
                          apiFetch(`/variants/${v.id}`, { method: 'PATCH', body: JSON.stringify(patch) })
                            .then(() => setRows((prev) => prev.map((p) => p.id === row.original.id ? {
                              ...p,
                              variants: p.variants?.map((vv) => vv.id === v.id ? { ...vv, ...patch } : vv),
                            } : p)))
                            .catch(() => toast.error('Kunne ikke gemme variant.'))
                        }
                      />
                    ))}
                  </React.Fragment>
                );
              })}
              {table.getRowModel().rows.length === 0 && (
                <tr>
                  <td colSpan={table.getVisibleLeafColumns().length} className="px-4 py-12 text-center">
                    <div className="text-slate-400 text-sm">Ingen produkter fundet</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Pagination ── */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between text-sm text-slate-500">
        <div>
          Viser <span className="font-medium text-slate-700">{startIndex}–{endIndex}</span> af <span className="font-medium text-slate-700">{totalRows}</span>
        </div>
        <div className="flex items-center gap-2">
          <select
            className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm focus:border-indigo-300 transition"
            value={pageSize}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
          >
            <option value={10}>10 pr. side</option>
            <option value={25}>25 pr. side</option>
            <option value={50}>50 pr. side</option>
            <option value={100}>100 pr. side</option>
          </select>
          <div className="flex items-center gap-1">
            <button
              className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition"
              disabled={page <= 1}
              onClick={() => onPageChange(Math.max(1, page - 1))}
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6"/></svg>
              <span>Forrige</span>
            </button>
            <span className="px-3 py-1.5 text-sm rounded-lg border border-slate-200 bg-slate-50 font-medium tabular-nums whitespace-nowrap">{page} / {totalPages}</span>
            <button
              className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-slate-500 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed transition"
              disabled={page >= totalPages}
              onClick={() => onPageChange(Math.min(totalPages, page + 1))}
            >
              <span>Næste</span>
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
            </button>
          </div>
        </div>
      </div>

      {/* ── Floating Bulk Action Bar ── */}
      <div
        className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 transition-all duration-300 ease-out ${
          effectiveCount > 0 ? 'translate-y-0 opacity-100 pointer-events-auto' : 'translate-y-16 opacity-0 pointer-events-none'
        }`}
      >
        <div className="flex items-center gap-1 rounded-2xl bg-slate-900 px-3 py-2.5 shadow-2xl border border-slate-700/60 ring-1 ring-black/10 text-white backdrop-blur">
          {/* Selected count badge */}
          <div className="flex items-center gap-2 pl-1 pr-3 border-r border-slate-700">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-indigo-500 text-[10px] font-bold tabular-nums">
              {effectiveCount > 99 ? '99+' : effectiveCount}
            </span>
            <span className="text-sm font-medium text-slate-200 whitespace-nowrap">
              {effectiveCount.toLocaleString('da-DK')} {effectiveCount === 1 ? 'produkt valgt' : 'produkter valgt'}
            </span>
          </div>

          {/* Publication status */}
          <div className="relative" ref={bulkStatusMenuRef}>
            <button
              disabled={!!bulkActionLoading}
              onClick={() => setBulkStatusMenuOpen((v) => !v)}
              className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800 hover:text-white transition disabled:opacity-40"
            >
              {bulkActionLoading === 'status' ? (
                <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
              ) : (
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="M12 6v6l4 2"/></svg>
              )}
              Publiceringsstatus
              <svg viewBox="0 0 24 24" className={`h-3 w-3 transition-transform ${bulkStatusMenuOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m6 9 6 6 6-6"/></svg>
            </button>
            {bulkStatusMenuOpen && (
              <div className="absolute bottom-full left-0 mb-2 w-44 rounded-xl border border-slate-100 bg-white shadow-2xl overflow-hidden py-1">
                {([
                  { value: 'ACTIVE',   label: 'Aktiv',      dot: 'bg-emerald-500', text: 'text-emerald-700', bg: 'hover:bg-emerald-50' },
                  { value: 'DRAFT',    label: 'Kladde',     dot: 'bg-amber-400',   text: 'text-amber-700',   bg: 'hover:bg-amber-50'   },
                  { value: 'ARCHIVED', label: 'Arkiveret',  dot: 'bg-slate-400',   text: 'text-slate-600',   bg: 'hover:bg-slate-50'   },
                ] as const).map(({ value, label, dot, text, bg }) => (
                  <button
                    key={value}
                    onClick={() => void bulkSetStatus(value)}
                    className={`flex w-full items-center gap-2.5 px-3.5 py-2.5 text-sm font-medium transition ${text} ${bg}`}
                  >
                    <span className={`h-2 w-2 rounded-full flex-shrink-0 ${dot}`} />
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Delete */}
          <button
            disabled={!!bulkActionLoading}
            onClick={() => setBulkConfirmDelete(true)}
            className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-sm text-red-400 hover:bg-red-950/60 hover:text-red-300 transition disabled:opacity-40"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
            Slet
          </button>

          {/* AI */}
          <button
            onClick={() => { setAiBatchPanelOpen(true); }}
            className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-sm text-indigo-300 hover:bg-indigo-950/60 hover:text-indigo-200 transition"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
            AI-generering
          </button>

          {/* Tolddata */}
          <button
            onClick={() => { setBulkCustomsOpen(true); setBulkCustomsResults([]); setBulkCustomsDone(false); setBulkCustomsRunning(false); }}
            className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-sm text-emerald-300 hover:bg-emerald-950/60 hover:text-emerald-200 transition"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 14 4 9l5-5"/><path d="m15 4 5 5-5 5"/><path d="M4 9h16"/></svg>
            Tolddata
          </button>

          {/* Alt-tekst */}
          <button
            onClick={() => setAltTextModalOpen(true)}
            className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-sm text-sky-300 hover:bg-sky-950/60 hover:text-sky-200 transition"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
            Alt-tekst
          </button>

          {/* Divider + clear selection */}
          <div className="w-px h-5 bg-slate-700 mx-0.5" />
          <button
            onClick={() => { setSelectedProductIds([]); setAllProductsSelected(false); }}
            className="flex items-center gap-1 rounded-xl px-2 py-1.5 text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition"
            aria-label="Ryd valg"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </div>

      {/* ── Alt-text Modal ── */}
      {altTextModalOpen && (
        <div className="fixed inset-0 z-[80] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white shadow-2xl overflow-hidden">
            <div className="flex items-center gap-3 px-5 py-4 bg-gradient-to-r from-sky-600 to-sky-700">
              <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-white/20">
                <svg viewBox="0 0 24 24" className="h-4 w-4 text-white" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
              </div>
              <div>
                <div className="text-sm font-semibold text-white">Generér alt-tekst</div>
                <div className="text-xs text-sky-200">{effectiveCount.toLocaleString('da-DK')} produkter · GPT-4o Vision</div>
              </div>
              <button type="button" onClick={() => setAltTextModalOpen(false)} className="ml-auto flex h-7 w-7 items-center justify-center rounded-lg text-white/70 hover:bg-white/20">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>
            <div className="px-5 py-4 space-y-4">
              <p className="text-sm text-slate-600">
                Genererer automatisk alt-tekst for produktbilleder ved hjælp af GPT-4o Vision. Eksisterende alt-tekster overskrives <strong>ikke</strong>.
              </p>
              <div>
                <label className="flex items-center gap-2 text-xs text-gray-500">
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-gray-400 shrink-0" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                  <span className="shrink-0">Email-notifikation:</span>
                  <input
                    type="email"
                    className="flex-1 min-w-0 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1 text-xs focus:border-sky-300 focus:outline-none transition"
                    placeholder="din@email.dk (valgfrit)"
                    value={altTextNotifyEmail}
                    onChange={(e) => setAltTextNotifyEmail(e.target.value)}
                  />
                </label>
              </div>
            </div>
            <div className="flex gap-3 px-5 pb-5">
              <button type="button" onClick={() => setAltTextModalOpen(false)} className="flex-1 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-600 hover:bg-slate-50 transition">
                Annullér
              </button>
              <button
                type="button"
                disabled={altTextRunning}
                onClick={() => void runAltTextBulk()}
                className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-60 transition"
              >
                {altTextRunning ? <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="60" strokeLinecap="round"/></svg> : null}
                Start generering
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Export Modal ── */}
      {exportModalOpen && (
        <div className="fixed inset-0 z-[80] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-slate-100">
              <h3 className="text-base font-semibold text-slate-900">Eksportér CSV</h3>
              <button onClick={() => setExportModalOpen(false)} className="text-slate-400 hover:text-slate-600 transition">
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>
            <div className="px-6 py-4">
              <p className="text-sm text-slate-500 mb-4">Vælg felter til eksporten. Alle produkter inkluderes — én række per variant.</p>
              <div className="space-y-4">
                {([
                  { group: 'Produktfelter', fields: [
                    { key: 'title', label: 'Produkttitel' },
                    { key: 'handle', label: 'Handle' },
                    { key: 'vendor', label: 'Leverandør' },
                    { key: 'productType', label: 'Produkttype' },
                    { key: 'status', label: 'Status' },
                  ]},
                  { group: 'Variantfelter', fields: [
                    { key: 'sku', label: 'SKU' },
                    { key: 'barcode', label: 'Stregkode / EAN' },
                    { key: 'price', label: 'Pris' },
                    { key: 'compareAtPrice', label: 'Sammenligningspris' },
                    { key: 'weight', label: 'Vægt' },
                    { key: 'weightUnit', label: 'Vægtenhed' },
                    { key: 'hsCode', label: 'HS-kode' },
                    { key: 'countryOfOrigin', label: 'Oprindelsesland' },
                  ]},
                ] as const).map(({ group, fields }) => (
                  <div key={group}>
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">{group}</div>
                    <div className="grid grid-cols-2 gap-1.5">
                      {fields.map(({ key, label }) => (
                        <label key={key} className="flex items-center gap-2 cursor-pointer select-none text-sm text-slate-700 hover:text-slate-900 py-0.5">
                          <input
                            type="checkbox"
                            className="rounded border-slate-300 accent-indigo-600"
                            checked={exportFieldsSelected.has(key)}
                            onChange={(e) => setExportFieldsSelected((prev) => {
                              const next = new Set(prev);
                              e.target.checked ? next.add(key) : next.delete(key);
                              return next;
                            })}
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-4 pt-4 border-t border-slate-100">
                <label className="flex items-center gap-2.5 cursor-pointer select-none text-sm text-slate-700">
                  <input
                    type="checkbox"
                    className="rounded border-slate-300 accent-indigo-600"
                    checked={exportIncludeDrafts}
                    onChange={(e) => setExportIncludeDrafts(e.target.checked)}
                  />
                  Inkludér kladdeændringer
                </label>
              </div>
            </div>
            <div className="flex justify-between items-center border-t border-slate-100 bg-slate-50/50 px-6 py-4">
              <button
                className="text-xs text-slate-400 hover:text-slate-600 transition"
                onClick={() => setExportFieldsSelected(new Set(['title', 'handle', 'vendor', 'productType', 'status', 'sku', 'barcode', 'price', 'compareAtPrice', 'weight', 'weightUnit', 'hsCode', 'countryOfOrigin']))}
              >
                Vælg alle
              </button>
              <div className="flex gap-2">
                <button className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 shadow-sm transition" onClick={() => setExportModalOpen(false)}>Annullér</button>
                <button
                  disabled={exportFieldsSelected.size === 0}
                  className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-40 shadow-sm transition"
                  onClick={() => void doExport()}
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>
                  Eksportér ({exportFieldsSelected.size})
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Bulk Customs Modal ── */}
      {bulkCustomsOpen && (
        <div className="fixed inset-0 z-[80] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white shadow-2xl flex flex-col max-h-[82vh]">
            {/* Header */}
            <div className="flex items-start justify-between px-6 pt-5 pb-4 border-b border-slate-100 flex-shrink-0">
              <div>
                <h3 className="text-base font-semibold text-slate-900">Bulk tolddata</h3>
                <p className="text-sm text-slate-500 mt-0.5">{effectiveCount.toLocaleString('da-DK')} produkt{effectiveCount !== 1 ? 'er' : ''} valgt</p>
              </div>
              <button
                onClick={() => setBulkCustomsOpen(false)}
                title={bulkCustomsRunning ? 'Kør i baggrunden' : 'Luk'}
                className="text-slate-400 hover:text-slate-600 transition mt-0.5"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg>
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {!bulkCustomsRunning && !bulkCustomsDone && (
                <>
                  <p className="text-sm text-slate-600">Vælg hvilke toldfelter AI skal generere for alle varianter på de valgte produkter. Varianter som AI ikke er 100% sikker på, springes over.</p>
                  <div className="rounded-xl border border-slate-200 divide-y divide-slate-100 overflow-hidden">
                    {([
                      { key: 'hsCode' as const, label: 'HS-kode', desc: '6–10 cifret toldkode, fx 6110201000' },
                      { key: 'countryOfOrigin' as const, label: 'Oprindelsesland', desc: 'ISO 2-bogstavs landekode, fx CN, DE, DK' },
                      { key: 'weight' as const, label: 'Vægt', desc: 'Estimeret produktvægt baseret på produktdata' },
                    ]).map(({ key, label, desc }) => (
                      <label key={key} className="flex items-start gap-3 px-4 py-3.5 cursor-pointer hover:bg-slate-50 transition">
                        <input
                          type="checkbox"
                          className="mt-0.5 rounded border-slate-300 accent-indigo-600"
                          checked={bulkCustomsFields[key]}
                          onChange={(e) => setBulkCustomsFields((p) => ({ ...p, [key]: e.target.checked }))}
                        />
                        <div className="flex-1">
                          <div className="text-sm font-medium text-slate-800">{label}</div>
                          <div className="text-xs text-slate-500 mt-0.5">{desc}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                  {bulkCustomsFields.weight && (
                    <>
                      <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                        <label className="block text-xs font-medium text-slate-600 mb-1.5">Vægtenhed</label>
                        <div className="flex gap-2">
                          {([
                            { value: 'KILOGRAMS' as const, label: 'kg' },
                            { value: 'GRAMS' as const, label: 'g' },
                            { value: 'POUNDS' as const, label: 'lbs' },
                            { value: 'OUNCES' as const, label: 'oz' },
                          ]).map(({ value, label }) => (
                            <button
                              key={value}
                              type="button"
                              onClick={() => setBulkCustomsWeightUnit(value)}
                              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${bulkCustomsWeightUnit === value ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                        <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-amber-600 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                          <path d="M12 9v4m0 4h.01"/>
                        </svg>
                        <div className="text-xs text-amber-800 space-y-0.5">
                          <div className="font-semibold">Vægt bruger web-søgning (gpt-4o-search-preview)</div>
                          <div>
                            Koster ~$0,025 pr. variant · estimeret{' '}
                            <span className="font-semibold">~${(effectiveCount * 0.025).toFixed(2)} USD (~{Math.round(effectiveCount * 0.025 * 6.9)} kr)</span>
                            {' '}for {effectiveCount.toLocaleString('da-DK')} produkt{effectiveCount !== 1 ? 'er' : ''}.
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                </>
              )}

              {(bulkCustomsRunning || bulkCustomsDone) && (
                <>
                  {/* Progress bar */}
                  <div>
                    <div className="flex items-center justify-between text-sm mb-2">
                      <span className="font-medium text-slate-700">{bulkCustomsDone ? 'Generering afsluttet' : 'Genererer...'}</span>
                      <span className="text-slate-500 tabular-nums">{bulkCustomsProgress.done} / {bulkCustomsProgress.total}</span>
                    </div>
                    <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-indigo-500 transition-all duration-300"
                        style={{ width: bulkCustomsProgress.total ? `${Math.round(bulkCustomsProgress.done / bulkCustomsProgress.total * 100)}%` : '0%' }}
                      />
                    </div>
                  </div>

                  {/* Results table */}
                  {bulkCustomsResults.length > 0 && (
                    <div className="rounded-xl border border-slate-200 overflow-hidden">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-200">
                            <th className="text-left px-3 py-2 font-medium text-slate-500">Produkt / SKU</th>
                            {bulkCustomsFields.hsCode && <th className="text-left px-3 py-2 font-medium text-slate-500">HS-kode</th>}
                            {bulkCustomsFields.countryOfOrigin && <th className="text-left px-3 py-2 font-medium text-slate-500 w-24">Oprind.</th>}
                            {bulkCustomsFields.weight && <th className="text-left px-3 py-2 font-medium text-slate-500 w-20">Vægt</th>}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {bulkCustomsResults.map((r) => (
                            <tr key={r.variantId} className="hover:bg-slate-50/50">
                              <td className="px-3 py-2">
                                <div className="font-medium text-slate-800 truncate max-w-[170px]">{r.productTitle}</div>
                                {r.sku && <div className="text-slate-400">{r.sku}</div>}
                              </td>
                              {bulkCustomsFields.hsCode && (
                                <td className="px-3 py-2">
                                  {r.hsCode?.status === 'ok' && <span className="font-mono text-emerald-700">{r.hsCode.value}</span>}
                                  {r.hsCode?.status === 'unsure' && <span className="text-amber-500">Ikke sikker</span>}
                                  {r.hsCode?.status === 'error' && <span className="text-red-400">Fejl</span>}
                                </td>
                              )}
                              {bulkCustomsFields.countryOfOrigin && (
                                <td className="px-3 py-2">
                                  {r.countryOfOrigin?.status === 'ok' && <span className="font-mono font-bold text-emerald-700">{r.countryOfOrigin.value}</span>}
                                  {r.countryOfOrigin?.status === 'unsure' && <span className="text-amber-500">Ikke sikker</span>}
                                  {r.countryOfOrigin?.status === 'error' && <span className="text-red-400">Fejl</span>}
                                </td>
                              )}
                              {bulkCustomsFields.weight && (
                                <td className="px-3 py-2">
                                  {r.weight?.status === 'ok' && <span className="font-mono text-emerald-700">{r.weight.value} {bulkCustomsWeightUnit === 'KILOGRAMS' ? 'kg' : bulkCustomsWeightUnit === 'GRAMS' ? 'g' : bulkCustomsWeightUnit === 'POUNDS' ? 'lbs' : 'oz'}</span>}
                                  {r.weight?.status === 'unsure' && <span className="text-amber-500">Ikke sikker</span>}
                                  {r.weight?.status === 'error' && <span className="text-red-400">Fejl</span>}
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Summary */}
                  {bulkCustomsDone && (() => {
                    const unsureCount = bulkCustomsResults.filter((r) => r.hsCode?.status === 'unsure' || r.countryOfOrigin?.status === 'unsure' || r.weight?.status === 'unsure').length;
                    return (
                      <div className="rounded-xl bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm space-y-1.5">
                        <div className="flex items-center gap-2 text-emerald-800 font-medium">
                          <svg viewBox="0 0 24 24" className="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                          {bulkCustomsAutoSaved} variant{bulkCustomsAutoSaved !== 1 ? 'er' : ''} gemt automatisk som kladde
                        </div>
                        {unsureCount > 0 && <div className="flex items-center gap-2 text-slate-500"><span className="h-2 w-2 rounded-full bg-amber-400 flex-shrink-0" />{unsureCount} variant{unsureCount !== 1 ? 'er' : ''} var AI ikke sikker på — sprunget over</div>}
                      </div>
                    );
                  })()}
                  {/* Auto-save progress while running */}
                  {bulkCustomsRunning && bulkCustomsAutoSaved > 0 && (
                    <div className="flex items-center gap-2 text-xs text-emerald-600">
                      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                      {bulkCustomsAutoSaved} gemt løbende...
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Footer */}
            <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50/50 px-6 py-4 flex-shrink-0">
              {!bulkCustomsRunning && !bulkCustomsDone && (
                <>
                  <input
                    type="email"
                    placeholder="Notifikation på email (valgfri)"
                    value={customsNotifyEmail}
                    onChange={(e) => setCustomsNotifyEmail(e.target.value)}
                    className="flex-1 min-w-0 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400"
                  />
                  <button className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 shadow-sm transition" onClick={() => setBulkCustomsOpen(false)}>Annullér</button>
                  <button
                    disabled={!bulkCustomsFields.hsCode && !bulkCustomsFields.countryOfOrigin && !bulkCustomsFields.weight}
                    className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-40 shadow-sm transition"
                    onClick={() => void startBulkCustoms()}
                  >
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
                    Start generering
                  </button>
                </>
              )}
              {bulkCustomsRunning && (
                <div className="flex items-center gap-3 w-full justify-between">
                  <div className="flex items-center gap-2 text-sm text-slate-500">
                    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                    Genererer og gemmer løbende...
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 transition"
                      onClick={() => setBulkCustomsOpen(false)}
                    >
                      Kør i baggrunden
                    </button>
                    <button
                      className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-sm text-red-600 hover:bg-red-100 transition"
                      onClick={() => { bulkCustomsCancelRef.current = true; }}
                    >
                      Stop
                    </button>
                  </div>
                </div>
              )}
              {bulkCustomsDone && (
                <>
                  <button className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 shadow-sm transition" onClick={() => { setBulkCustomsOpen(false); setBulkCustomsResults([]); setBulkCustomsDone(false); setBulkCustomsAutoSaved(0); }}>Luk</button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Background customs progress indicator ── */}
      {bulkCustomsRunning && !bulkCustomsOpen && (
        <div className="fixed bottom-24 right-6 z-50">
          <button
            onClick={() => setBulkCustomsOpen(true)}
            className="flex items-center gap-3 rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl px-4 py-3 text-white hover:bg-slate-800 transition"
          >
            <svg className="h-4 w-4 animate-spin flex-shrink-0 text-indigo-400" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
            <div className="text-sm">
              <div className="font-medium">Tolddata kører...</div>
              <div className="text-xs text-slate-400 tabular-nums">{bulkCustomsProgress.done} / {bulkCustomsProgress.total} varianter</div>
            </div>
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-slate-500 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
          </button>
        </div>
      )}

      {/* ── Delete Confirmation Modal ── */}
      {bulkConfirmDelete && (
        <div className="fixed inset-0 z-[70] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="px-6 pt-6 pb-5">
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-red-100 mb-5">
                <svg viewBox="0 0 24 24" className="h-5 w-5 text-red-600" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
              </div>
              <h3 className="text-lg font-semibold text-slate-900">
                Slet {effectiveCount.toLocaleString('da-DK')} {effectiveCount === 1 ? 'produkt' : 'produkter'}?
              </h3>
              <p className="text-sm text-slate-500 mt-1.5 leading-relaxed">
                Produkterne slettes permanent fra ePIM. Denne handling kan ikke fortrydes.
              </p>
              <div className="mt-4 rounded-xl border border-slate-100 bg-slate-50 px-4 py-3 max-h-40 overflow-y-auto space-y-1">
                {selectedProductIds.slice(0, 6).map((id) => {
                  const p = rows.find((r) => r.id === id);
                  return (
                    <div key={id} className="flex items-center gap-2 text-sm text-slate-700">
                      <span className="h-1.5 w-1.5 rounded-full bg-slate-300 flex-shrink-0" />
                      <span className="truncate">{p?.title ?? id}</span>
                    </div>
                  );
                })}
                {effectiveCount > 6 && (
                  <div className="text-xs text-slate-400 pt-1 pl-3.5">... og {effectiveCount - 6} til</div>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50/50 px-6 py-4">
              <button
                className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 shadow-sm transition"
                onClick={() => setBulkConfirmDelete(false)}
              >
                Annullér
              </button>
              <button
                disabled={bulkActionLoading === 'delete'}
                className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-60 shadow-sm transition"
                onClick={() => void bulkDelete()}
              >
                {bulkActionLoading === 'delete' ? (
                  <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                ) : null}
                Slet {effectiveCount.toLocaleString('da-DK')} {effectiveCount === 1 ? 'produkt' : 'produkter'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
