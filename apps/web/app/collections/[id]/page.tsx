'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { API_URL, apiFetch, getActiveShopId, getToken } from '../../../lib/api';
import { registerBackgroundActivityJobs } from '../../../lib/background-activity';
import { toast } from '../../../components/toaster';

type Collection = {
  id: string;
  title: string;
  handle: string;
  descriptionHtml?: string | null;
  createdAt: string;
  updatedAt: string;
  lastShopifySyncAt?: string | null;
  shopifyCollectionGid?: string | null;
  shop?: { shopUrl?: string | null } | null;
  fieldValues?: Array<{
    id: string;
    fieldDefinitionId: string;
    valueJson: unknown;
    fieldDefinition: { id: string; key: string; label: string };
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

type ReusableSource = {
  id: string;
  name: string;
  type: 'web' | 'products' | 'product_feed';
  feedType?: 'live_url' | 'static_file';
  promptTemplate?: string;
  active: boolean;
};

type PromptTemplate = {
  id: string;
  name: string;
  body: string;
  active: boolean;
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

const execEditorCommand = (command: string): void => {
  if (typeof document === 'undefined') return;
  document.execCommand(command);
};

const insertEditorLink = (): void => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const url = window.prompt('Indsæt URL');
  if (!url) return;
  document.execCommand('createLink', false, url);
};

const DEFAULT_AI_BASE_PROMPT = `Du er en senior e-commerce copywriter og PIM-specialist.

Du modtager kollektionsdata og skal generere feltværdi, der er:
- præcis og faktuel i forhold til input
- SEO-optimeret med naturligt sprog
- skrevet på dansk
- klar til publicering i en webshop
- fri for overdrivelser og usande claims

Regler:
1) Brug kun data der er givet i input.
2) Hvis data mangler, så antag ikke detaljer.
3) Skriv skarpt, kommercielt og letlæseligt.
4) Returnér kun den endelige feltværdi uden forklaringer.

Tilgængelige placeholders i prompt:
{{title}}, {{handle}}, {{descriptionHtml}}`;

const DEFAULT_AI_PROMPT_PRESETS: Array<{ label: string; instruction: string }> = [
  {
    label: 'Kollektionsbeskrivelse',
    instruction: `Skriv en engagerende, konverteringsoptimeret kollektionsbeskrivelse i HTML-format. Strukturér som 2-3 korte afsnit med <p>-tags. Første afsnit: hvad kollektionen indeholder og hvem den er til. Andet afsnit: de primære fordele og det, der adskiller kollektionen. Tredje afsnit (valgfrit): en stærk call-to-action. Skriv i et klart, tillidsfuldt sprog tilpasset brandets tone — undgå klichéer og tomme superlativer. Brug kun data der er givet.`,
  },
  {
    label: 'Metatitel',
    instruction: `Generér en SEO-metatitel til en kollektion. STRENGT KRAV: Resultatet MÅ ABSOLUT IKKE overstige 60 tegn — tæl tegnene inden du returnerer. Primært søgeord tidligt i titlen, kollektionsnavnet inkluderet, naturligt og klikvenligt. Ingen udråbstegn, ingen marketing-snak. Eksempelformat: "Herrejakker i læder | BrandNavn" eller "Sengetøj i øko-bomuld – Shop her". Hvis udkastet er over 60 tegn, skær ned og prøv igen.`,
  },
  {
    label: 'Metabeskrivelse',
    instruction: `Generér en SEO-metabeskrivelse til en kollektion. STRENGT KRAV: Resultatet SKAL være mellem 140 og 160 tegn — tæl tegnene inden du returnerer. Er udkastet kortere end 140 tegn, uddyb fordele eller tilføj call-to-action. Er det over 160 tegn, skær ned. Indhold: hvad kollektionen tilbyder, primær fordel for kunden, og ét konkret call-to-action (fx "Shop nu", "Se udvalget", "Find din størrelse"). Inkludér primært søgeord naturligt — ingen generiske sætninger.`,
  },
  {
    label: 'Kort beskrivelse',
    instruction: `Skriv en kort, slagkraftig beskrivelse af kollektionen i 1-2 sætninger (max 200 tegn). Fokusér på hvad kollektionen er, og hvem den henvender sig til. Egnet til forside-widgets, kategori-kort eller app-snippets.`,
  },
];

// Maps field keys and label patterns to collection AI preset labels
const FIELD_PRESET_MAP: Array<{ match: (key: string, label: string) => boolean; presetLabel: string }> = [
  { match: (k) => k === '_meta_title' || /meta[_\s-]?titel|seo[_\s-]?titel|meta[_\s-]?title|seo[_\s-]?title/.test(k), presetLabel: 'Metatitel' },
  { match: (k) => k === '_meta_description' || /meta[_\s-]?beskriv|seo[_\s-]?beskriv|meta[_\s-]?desc|seo[_\s-]?desc/.test(k), presetLabel: 'Metabeskrivelse' },
  { match: (k, l) => /kort[_\s-]?beskriv|short[_\s-]?desc|excerpt|uddrag/.test(k) || /kort[_\s-]?beskriv|short[_\s-]?desc|uddrag/.test(l), presetLabel: 'Kort beskrivelse' },
  { match: (k) => k === '_description' || k === '_col_description' || /beskriv|description|body/.test(k), presetLabel: 'Kollektionsbeskrivelse' },
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

const RECENT_COMPETITOR_LINKS_KEY = 'elpim_recent_competitor_links';

const normalizeCompetitorInput = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parseUrl = (candidate: string): URL | null => {
    try { return new URL(candidate); } catch { return null; }
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
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
};

export default function CollectionDetailsPage() {
  const { id } = useParams<{ id: string }>();
  const [collection, setCollection] = useState<Collection | null>(null);
  const [fields, setFields] = useState<FieldDefinition[]>([]);
  const [fieldEdits, setFieldEdits] = useState<Record<string, string>>({});
  const initialFieldEditsRef = useRef<Record<string, string>>({});
  const [handleEdit, setHandleEdit] = useState('');
  const initialHandleRef = useRef('');
  const htmlEditorRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const htmlEditorDomValueRef = useRef<Record<string, string>>({});
  const [htmlEditorMode, setHtmlEditorMode] = useState<Record<string, 'visual' | 'source'>>({});
  const [message, setMessage] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [draftSaveStatus, setDraftSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [showStamdata, setShowStamdata] = useState(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem('elpim_show_stamdata_col') !== 'false';
  });

  // AI state
  const [selectedFieldId, setSelectedFieldId] = useState('');
  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiLaunching, setAiLaunching] = useState(false);
  const [isGeneratingAi, setIsGeneratingAi] = useState(false);
  const [activeAiJobId, setActiveAiJobId] = useState<string | null>(null);
  const [aiResultPopup, setAiResultPopup] = useState<{ fieldLabel: string; value: string } | null>(null);
  const [aiInstruction, setAiInstruction] = useState('Skriv en skarp og SEO-optimeret værdi til det valgte felt, baseret på kollektionsdata.');
  const [aiUseHtmlOutput, setAiUseHtmlOutput] = useState(false);
  const [aiUseWebSearch, setAiUseWebSearch] = useState(false);
  const [aiOutputLength, setAiOutputLength] = useState<'kort' | 'mellem' | 'lang'>('mellem');
  const [aiKeywords, setAiKeywords] = useState('');
  const [aiNegativeKeywords, setAiNegativeKeywords] = useState('');
  const [brandVoiceLock, setBrandVoiceLock] = useState(true);
  const [brandVoiceGuide, setBrandVoiceGuide] = useState('Professionel tone: teknisk kompetent, tillidsvækkende, konkret og handlingsorienteret. Undgå hype og fluffy vendinger.');
  const [competitorLinksInput, setCompetitorLinksInput] = useState('');
  const [recentCompetitorLinks, setRecentCompetitorLinks] = useState<string[]>([]);
  const [reusableSources, setReusableSources] = useState<ReusableSource[]>([]);
  const [savedPrompts, setSavedPrompts] = useState<PromptTemplate[]>([]);
  const [selectedPromptId, setSelectedPromptId] = useState('');
  const [aiPromptPresets, setAiPromptPresets] = useState<Array<{ label: string; instruction: string }>>(DEFAULT_AI_PROMPT_PRESETS);
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [sourcesOnly, setSourcesOnly] = useState(false);
  const [history, setHistory] = useState<Array<{ id: string; source: string; createdAt: string }>>([]);
  const [detailedHistory, setDetailedHistory] = useState<HistoryLog[]>([]);
  const [historySnapshots, setHistorySnapshots] = useState<HistorySnapshot[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyTab, setHistoryTab] = useState<'changes' | 'snapshots'>('changes');
  const [userPlatformRole, setUserPlatformRole] = useState<string>('none');
  const [userRole, setUserRole] = useState<string>('member');
  const [lockPopoverId, setLockPopoverId] = useState<string | null>(null);

  // Close lock popover on outside click
  useEffect(() => {
    if (!lockPopoverId) return;
    const handler = () => setLockPopoverId(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [lockPopoverId]);

  // Sync fieldEdits into HTML editor DOM
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

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = window.localStorage.getItem(RECENT_COMPETITOR_LINKS_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored) as string[];
      if (Array.isArray(parsed)) {
        setRecentCompetitorLinks(parsed.filter((item) => typeof item === 'string'));
      }
    } catch {
      setRecentCompetitorLinks([]);
    }
  }, []);

  useEffect(() => {
    const selectedField = fields.find((f) => f.id === selectedFieldId);
    if (selectedField?.type === 'html') {
      setAiUseHtmlOutput(true);
    }
  }, [fields, selectedFieldId]);

  useEffect(() => {
    Promise.all([
      apiFetch<{ collection: Collection; fields: FieldDefinition[] }>(`/collections/${id}`),
      apiFetch<{ sources: ReusableSource[] }>('/sources'),
      apiFetch<{ prompts: PromptTemplate[] }>('/prompts'),
      apiFetch<{ settings: Array<{ key: string; valueJson: unknown }> }>('/settings'),
      apiFetch<{ drafts: Array<{ patchJson: Record<string, unknown> }> }>(`/drafts?entityType=collection&entityId=${id}`),
      apiFetch<{ logs: Array<{ id: string; source: string; createdAt: string }> }>(`/changelog?entityId=${id}`),
      apiFetch<{ user: { platformRole?: string; role?: string } | null }>('/me'),
      apiFetch<{ quickPresets: Array<{ label: string; instruction: string }> | null }>('/shops/ai-settings').catch(() => ({ quickPresets: null })),
    ])
      .then(([collectionResponse, sourceResponse, promptsResponse, settingsResponse, draftResponse, logResponse, meResponse, aiSettingsResponse]) => {
        const c = collectionResponse.collection;
        const collFields = collectionResponse.fields;
        setCollection(c);
        document.title = `${c.title} | EL-PIM`;
        setFields(collFields);
        setHandleEdit(c.handle ?? '');
        initialHandleRef.current = c.handle ?? '';

        const initialEdits: Record<string, string> = {};
        for (const field of collFields) {
          const fv = c.fieldValues?.find((v) => v.fieldDefinitionId === field.id)?.valueJson;
          if (fv != null) {
            initialEdits[field.id] = String(fv);
          } else if (field.key === '_col_title') {
            initialEdits[field.id] = c.title ?? '';
          } else if (field.key === '_col_description') {
            initialEdits[field.id] = c.descriptionHtml ?? '';
          } else {
            initialEdits[field.id] = '';
          }
        }

        // Hydrate from draft
        const latestDraftPatch = draftResponse.drafts[0]?.patchJson ?? {};
        const byKey = new Map(collFields.map((f) => [f.key, f]));
        for (const [draftKey, draftValue] of Object.entries(latestDraftPatch)) {
          if (draftKey === 'handle') {
            const h = String(draftValue ?? '');
            setHandleEdit(h);
            initialHandleRef.current = h;
            continue;
          }
          const byIdField = collFields.find((f) => f.id === draftKey);
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
        setDraftSaveStatus('idle');
        setHistory(logResponse.logs);

        if (collFields[0]) setSelectedFieldId(collFields[0].id);

        setReusableSources(sourceResponse.sources.filter((s) => s.active));
        const activePrompts = promptsResponse.prompts.filter((p) => p.active);
        setSavedPrompts(activePrompts);
        if (activePrompts[0]) setSelectedPromptId(activePrompts[0].id);

        const settingsMap = settingsResponse.settings.reduce<Record<string, unknown>>((acc, item) => {
          acc[item.key] = item.valueJson;
          return acc;
        }, {});
        setBrandVoiceLock(String(settingsMap.brandVoiceLock ?? 'true') !== 'false');
        setBrandVoiceGuide(
          String(settingsMap.brandVoiceGuide ?? 'Professionel tone: teknisk kompetent, tillidsvækkende, konkret og handlingsorienteret. Undgå hype og fluffy vendinger.'),
        );
        setUserPlatformRole(meResponse.user?.platformRole ?? 'none');
        setUserRole(meResponse.user?.role ?? 'member');
        if (aiSettingsResponse.quickPresets) {
          const collectionPresets = (aiSettingsResponse.quickPresets as Array<{ label: string; instruction: string; scope?: string }>).filter((p) => p.scope === 'collection');
          if (collectionPresets.length > 0) setAiPromptPresets(collectionPresets);
        }
      })
      .catch(() => {
        setCollection(null);
        setMessage('Kunne ikke indlæse kollektion.');
      });
  }, [id]);

  // AI polling
  useEffect(() => {
    if (!activeAiJobId || !collection) return;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const status = await apiFetch<{ jobs: Array<{ id: string; status: string; error?: string | null }> }>('/sync-jobs/status', {
          method: 'POST',
          body: JSON.stringify({ jobIds: [activeAiJobId] }),
        });
        if (cancelled) return;
        const job = status.jobs[0];
        if (!job) return;
        if (job.status === 'done') {
          const refreshed = await apiFetch<{ collection: Collection; fields: FieldDefinition[] }>(`/collections/${collection.id}`);
          if (cancelled) return;
          setCollection(refreshed.collection);
          const selectedField = fields.find((f) => f.id === selectedFieldId);
          const latestValue = refreshed.collection.fieldValues?.find((v) => v.fieldDefinitionId === selectedFieldId)?.valueJson;
          const valueText = latestValue == null ? '' : String(latestValue);
          setFieldEdits((prev) => ({ ...prev, [selectedFieldId]: valueText }));
          setAiResultPopup({ fieldLabel: selectedField?.label ?? 'Felt', value: valueText });
          setActiveAiJobId(null);
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
    return () => { cancelled = true; clearInterval(intervalId); };
  }, [activeAiJobId, collection, fields, selectedFieldId]);

  const placeholderHelp = useMemo(() => ['{{title}}', '{{handle}}', '{{descriptionHtml}}'], []);

  const competitorUrlLines = useMemo(
    () => competitorLinksInput.split('\n').map((l) => l.trim()).filter(Boolean),
    [competitorLinksInput],
  );

  const parsedCompetitorUrls = useMemo(
    () => competitorUrlLines.map((value) => ({ value, normalized: normalizeCompetitorInput(value), valid: Boolean(normalizeCompetitorInput(value)) })),
    [competitorUrlLines],
  );

  const validCompetitorUrls = useMemo(
    () => Array.from(new Set(parsedCompetitorUrls.filter((i) => i.valid).map((i) => i.normalized as string))),
    [parsedCompetitorUrls],
  );

  const aiPrompt = useMemo(() => {
    const fieldLabel = fields.find((f) => f.id === selectedFieldId)?.label ?? 'Valgt felt';
    const htmlInstruction = aiUseHtmlOutput
      ? '\n\nHTML OUTPUT AKTIVERET:\nReturnér output som gyldig, semantisk HTML (fx p, h2, ul/li). Returnér kun HTML-koden.'
      : '';
    const webSearchInstruction = aiUseWebSearch
      ? '\n\nWEB SØGNING AKTIVERET:\nDu må aktivt søge på web for opdateret kontekst og formulering.'
      : '';
    const lengthInstruction = `\n\nØNSKET LÆNGDE: ${aiOutputLength}`;
    const keywords = aiKeywords.split(',').map((k) => k.trim()).filter(Boolean);
    const keywordInstruction = keywords.length ? `\n\nSEO NØGLEORD (brug naturligt): ${keywords.join(', ')}` : '';
    const negativeKeywords = aiNegativeKeywords.split(',').map((k) => k.trim()).filter(Boolean);
    const negativeKeywordInstruction = negativeKeywords.length ? `\n\nNEGATIVE KEYWORDS (undgå disse): ${negativeKeywords.join(', ')}` : '';
    const brandVoiceInstruction = brandVoiceLock ? `\n\nBRAND VOICE LOCK (obligatorisk):\n${brandVoiceGuide}` : '';
    const competitorInputs = competitorLinksInput.split('\n').map((l) => l.trim()).filter(Boolean);
    const normalizedCompetitors = competitorInputs.map((i) => normalizeCompetitorInput(i)).filter((v): v is string => Boolean(v));
    const competitorDomains = normalizedCompetitors.map((u) => domainFromUrl(u));
    const competitorInstruction = competitorDomains.length
      ? `\n\nKONKURRENT-DOMÆNER (find selv relevante sider):\n${competitorDomains.map((d) => `- ${d}`).join('\n')}\nSøg aktivt på disse domæner og brug fundene som inspiration uden at kopiere direkte.`
      : '';
    const activeSourcesToShow = selectedSourceIds.length > 0
      ? reusableSources.filter((s) => selectedSourceIds.includes(s.id))
      : reusableSources.filter((s) => s.feedType === 'static_file' || s.type === 'products');
    const sourcePreview = activeSourcesToShow.length > 0
      ? `\n\n--- DATAKILDER (injiceres ved generering) ---\n${activeSourcesToShow.map((s) => `[${s.name}]: ${s.promptTemplate ?? 'Standard datakilde-prompt'}`).join('\n')}`
      : '';
    const sourcesOnlyPreview = sourcesOnly && activeSourcesToShow.length > 0
      ? '\n\nVIGTIGT — BRUG UDELUKKENDE KILDEDATA: Brug kun information fra kildedataene.'
      : '';
    return `${DEFAULT_AI_BASE_PROMPT}\n\nFELT DU SKAL GENERERE TIL: ${fieldLabel}\n\nSUPPLERENDE INSTRUKTION:\n${aiInstruction}${lengthInstruction}${keywordInstruction}${negativeKeywordInstruction}${brandVoiceInstruction}${htmlInstruction}${webSearchInstruction}${competitorInstruction}${sourcePreview}${sourcesOnlyPreview}`;
  }, [
    aiInstruction, aiKeywords, aiNegativeKeywords, aiOutputLength, brandVoiceGuide, brandVoiceLock,
    aiUseHtmlOutput, aiUseWebSearch, competitorLinksInput, fields, reusableSources,
    selectedFieldId, selectedSourceIds, sourcesOnly,
  ]);

  const hasFieldChanges = useCallback((): boolean => {
    const initial = initialFieldEditsRef.current;
    return Object.keys(fieldEdits).some((key) => (fieldEdits[key] ?? '') !== (initial[key] ?? ''));
  }, [fieldEdits]);

  const hasHandleChanges = handleEdit !== initialHandleRef.current;
  const hasUnsavedChanges = hasFieldChanges() || hasHandleChanges;

  // Draft auto-save
  useEffect(() => {
    if (!collection) return;
    const changedFields = fields.filter((f) => (fieldEdits[f.id] ?? '') !== (initialFieldEditsRef.current[f.id] ?? ''));
    const handleChanged = handleEdit !== initialHandleRef.current;
    if (changedFields.length === 0 && !handleChanged) return;
    setDraftSaveStatus('idle');
    const timeoutId = setTimeout(() => {
      const patchJson: Record<string, unknown> = {};
      for (const f of changedFields) patchJson[f.key] = fieldEdits[f.id] ?? '';
      if (handleChanged) patchJson.handle = handleEdit;
      setDraftSaveStatus('saving');
      apiFetch('/drafts', {
        method: 'PUT',
        body: JSON.stringify({ entityType: 'collection', entityId: collection.id, patchJson }),
      }).then(() => setDraftSaveStatus('saved')).catch(() => setDraftSaveStatus('idle'));
    }, 2000);
    return () => clearTimeout(timeoutId);
  }, [fieldEdits, handleEdit, collection, fields]);

  // Beforeunload flush
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const handler = () => {
      if (draftSaveStatus === 'saved' || draftSaveStatus === 'saving') return;
      if (!collection) return;
      const patchJson: Record<string, string> = {};
      for (const f of fields) {
        if ((fieldEdits[f.id] ?? '') !== (initialFieldEditsRef.current[f.id] ?? '')) {
          patchJson[f.key] = fieldEdits[f.id] ?? '';
        }
      }
      if (handleEdit !== initialHandleRef.current) patchJson.handle = handleEdit;
      if (Object.keys(patchJson).length === 0) return;
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
        body: JSON.stringify({ entityType: 'collection', entityId: collection.id, patchJson }),
      });
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsavedChanges, draftSaveStatus, collection, fields, fieldEdits, handleEdit]);

  const refreshHistory = useCallback(async (collectionId: string): Promise<void> => {
    try {
      const [logRes, histRes] = await Promise.all([
        apiFetch<{ logs: Array<{ id: string; source: string; createdAt: string }> }>(`/changelog?entityId=${collectionId}`),
        apiFetch<{ logs: HistoryLog[]; snapshots: HistorySnapshot[] }>(`/collections/${collectionId}/history`),
      ]);
      setHistory(logRes.logs);
      setDetailedHistory(histRes.logs);
      setHistorySnapshots(histRes.snapshots);
    } catch {
      // ignore
    }
  }, []);

  const saveCollection = useCallback(async (syncNow: boolean): Promise<void> => {
    if (!collection) return;
    setIsSaving(true);
    try {
      const titleField = fields.find((f) => f.key === '_col_title');
      const descField = fields.find((f) => f.key === '_col_description');
      const customFields = fields.filter((f) => !f.isBuiltIn);
      const fieldValuesRecord: Record<string, string> = {};
      for (const f of customFields) fieldValuesRecord[f.id] = fieldEdits[f.id] ?? '';

      const response = await apiFetch<{ collection: Collection; syncJobId?: string | null }>(`/collections/${collection.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: titleField ? (fieldEdits[titleField.id] ?? collection.title) : undefined,
          handle: handleEdit,
          descriptionHtml: descField ? (fieldEdits[descField.id] ?? collection.descriptionHtml) : undefined,
          fieldValues: Object.keys(fieldValuesRecord).length > 0 ? fieldValuesRecord : undefined,
          syncNow,
        }),
      });

      setCollection(response.collection);
      initialFieldEditsRef.current = { ...fieldEdits };
      initialHandleRef.current = handleEdit;
      setDraftSaveStatus('idle');
      apiFetch(`/drafts/collection/${collection.id}`, { method: 'DELETE' }).catch(() => {});
      void refreshHistory(collection.id);

      if (syncNow) {
        if (response.syncJobId) registerBackgroundActivityJobs([response.syncJobId]);
        toast.success('Kollektion gemt og sendt til Shopify sync-køen.');
      } else {
        toast.success('Kladde gemt.');
      }
    } catch {
      toast.error(syncNow ? 'Kunne ikke gemme og synkronisere.' : 'Kunne ikke gemme kladde.');
    } finally {
      setIsSaving(false);
    }
  }, [collection, fields, fieldEdits, handleEdit, refreshHistory]);

  // Cmd+S shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (hasUnsavedChanges && !isSaving) void saveCollection(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [hasUnsavedChanges, isSaving, saveCollection]);

  const runAiForSelectedField = async (): Promise<void> => {
    if (!collection || !selectedFieldId) {
      setMessage('Vælg et felt først.');
      return;
    }
    setIsGeneratingAi(true);
    try {
      const response = await apiFetch<{ jobId: string }>('/ai/apply', {
        method: 'POST',
        body: JSON.stringify({
          rows: [{ ownerType: 'collection', ownerId: collection.id }],
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
      setMessage(error instanceof Error ? (error.message || fallback) : fallback);
    } finally {
      setIsGeneratingAi(false);
    }
  };

  const applySavedPrompt = (): void => {
    const selected = savedPrompts.find((p) => p.id === selectedPromptId);
    if (selected) setAiInstruction(selected.body);
  };

  const resetAiPanel = (): void => {
    setAiInstruction('Skriv en skarp og SEO-optimeret værdi til det valgte felt, baseret på kollektionsdata.');
    setAiOutputLength('mellem');
    setAiKeywords('');
    setAiNegativeKeywords('');
    setAiUseWebSearch(false);
    setCompetitorLinksInput('');
  };

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

  const toggleStamdata = (): void => {
    const next = !showStamdata;
    setShowStamdata(next);
    if (typeof window !== 'undefined') window.localStorage.setItem('elpim_show_stamdata_col', String(next));
  };

  const isAdmin = userRole === 'owner' || userPlatformRole === 'platform_admin' || userPlatformRole === 'platform_support';
  const isFieldLockedForMe = (lockLevel: 'none' | 'users' | 'all' | undefined): boolean =>
    lockLevel === 'all' || (lockLevel === 'users' && !isAdmin);

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
              <button className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-left transition hover:bg-slate-50 ${level === 'none' ? 'font-semibold text-slate-800' : 'text-slate-600'}`} onClick={() => void setFieldLockLevel(fieldId, 'none')}>
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 opacity-40" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>
                Ikke låst
              </button>
              <button className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-left transition hover:bg-slate-50 ${level === 'users' ? 'font-semibold text-slate-800' : 'text-slate-600'}`} onClick={() => void setFieldLockLevel(fieldId, 'users')}>
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-amber-500" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                <span>Lås for brugere <span className="text-slate-400">(admins kan redigere)</span></span>
              </button>
              <button className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-left transition hover:bg-slate-50 ${level === 'all' ? 'font-semibold text-slate-800' : 'text-slate-600'}`} onClick={() => void setFieldLockLevel(fieldId, 'all')}>
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

  if (!collection) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="rounded-xl border border-gray-200 bg-white p-5 h-24" />
        <div className="rounded-xl border border-gray-200 bg-white p-5 h-64" />
      </div>
    );
  }

  const titleField = fields.find((f) => f.key === '_col_title');
  const descField = fields.find((f) => f.key === '_col_description');
  const customFields = fields.filter((f) => !f.isBuiltIn);

  return (
    <div className={`space-y-4 ${hasUnsavedChanges ? 'pb-20' : ''}`}>

      {/* AI Result Popup */}
      {aiResultPopup ? (
        <div className="fixed right-6 top-6 z-[70] w-[380px] animate-[fadeInUp_240ms_ease-out] rounded-2xl border border-emerald-200 bg-white p-3 shadow-2xl">
          <div className="mb-1 flex items-center justify-between">
            <div className="text-sm font-semibold text-emerald-700">AI færdig · {aiResultPopup.fieldLabel}</div>
            <button className="rounded border border-gray-300 px-2 py-0.5 text-xs" onClick={() => setAiResultPopup(null)}>Luk</button>
          </div>
          {(() => {
            const isHtmlField = fields.find((f) => f.id === selectedFieldId)?.type === 'html';
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
              onClick={() => { void saveCollection(true); setAiResultPopup(null); }}
            >
              <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>
              Gem og synkronisér
            </button>
          </div>
        </div>
      ) : null}

      {/* AI Modal */}
      {aiModalOpen && (
        <div className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={() => setAiModalOpen(false)} />
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
                    {(['kort', 'mellem', 'lang'] as const).map((len, i) => (
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
                    placeholder="fx lamper, loft, design"
                  />
                </div>
                <div>
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Negative nøgleord</span>
                    <div className="group relative">
                      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-gray-300 cursor-help hover:text-gray-400 transition" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                      <div className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 rounded-xl bg-gray-900 px-3 py-2.5 text-xs text-gray-100 opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-50 leading-relaxed shadow-xl">
                        Ord og fraser AI'en aktivt skal undgå i outputtet.
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

              {/* Advanced */}
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
                                setSelectedSourceIds((prev) => e.target.checked ? [...prev, source.id] : prev.filter((sid) => sid !== source.id));
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

      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-xs text-slate-400">
        <Link href="/dashboard/collections" className="hover:text-indigo-600 transition">Kollektioner</Link>
        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6"/></svg>
        <span className="text-slate-600 font-medium truncate">{collection.title}</span>
      </div>

      {/* Collection header */}
      <div className="ep-card-strong p-4 md:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-gray-900 leading-tight">{collection.title}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-gray-400">{collection.handle}</span>
              {(() => {
                if (!collection.shopifyCollectionGid || !collection.shop?.shopUrl) return null;
                const gidParts = collection.shopifyCollectionGid.split('/');
                const numericId = gidParts[gidParts.length - 1];
                const shopDomain = collection.shop.shopUrl.replace(/^https?:\/\//, '');
                return (
                  <a
                    href={`https://${shopDomain}/admin/collections/${numericId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100 hover:border-emerald-300 transition"
                  >
                    <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/></svg>
                    Se i Shopify
                  </a>
                );
              })()}
              {collection.shop?.shopUrl && collection.handle && (
                <a
                  href={`https://${collection.shop.shopUrl.replace(/^https?:\/\//, '')}/collections/${collection.handle}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-[11px] font-semibold text-indigo-700 hover:bg-indigo-100 hover:border-indigo-300 transition"
                >
                  <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/></svg>
                  Se på webshop
                </a>
              )}
              {collection.lastShopifySyncAt && (
                <span className="text-xs text-gray-400">
                  Sidst synkroniseret: {new Date(collection.lastShopifySyncAt).toLocaleString('da-DK', { dateStyle: 'short', timeStyle: 'short' })}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {hasUnsavedChanges && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-medium text-amber-700">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                Ikke-gemte ændringer
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Stamdata */}
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
            {titleField && (
              <div className="text-sm">
                <div className="flex items-center justify-between mb-1.5">
                  <label htmlFor={`field-${titleField.id}`} className="block text-xs font-semibold uppercase tracking-wide text-gray-400">
                    {titleField.label}
                  </label>
                  <button
                    type="button"
                    className="flex items-center gap-1 rounded border border-indigo-200 bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-100 transition"
                    onClick={() => openAiModalForField(titleField.id)}
                  >
                    <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
                    Generér
                  </button>
                </div>
                <input
                  id={`field-${titleField.id}`}
                  className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700 focus:border-indigo-300 focus:bg-white focus:outline-none transition"
                  value={fieldEdits[titleField.id] ?? ''}
                  onChange={(e) => setFieldEdits((prev) => ({ ...prev, [titleField.id]: e.target.value }))}
                />
              </div>
            )}

            {/* Beskrivelse */}
            {descField && (() => {
              const mode = htmlEditorMode[descField.id] ?? 'visual';
              return (
                <div className="text-sm">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="block text-xs font-semibold uppercase tracking-wide text-gray-400">
                      {descField.label}
                    </span>
                  </div>
                  <div className="rounded-lg border border-gray-300 bg-white">
                    <div className="flex flex-wrap items-center gap-1 border-b border-gray-200 p-2">
                      <button type="button" className={`rounded border px-2 py-1 text-xs ${mode === 'visual' ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-gray-300'}`} onClick={() => setHtmlEditorMode((prev) => ({ ...prev, [descField.id]: 'visual' }))}>Visuel</button>
                      <button type="button" className={`rounded border px-2 py-1 text-xs ${mode === 'source' ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-gray-300'}`} onClick={() => setHtmlEditorMode((prev) => ({ ...prev, [descField.id]: 'source' }))}>Kildekode</button>
                      <button type="button" className="rounded border border-gray-300 px-2 py-1 text-xs" onClick={() => execEditorCommand('bold')}>Fed</button>
                      <button type="button" className="rounded border border-gray-300 px-2 py-1 text-xs" onClick={() => execEditorCommand('italic')}>Kursiv</button>
                      <button type="button" className="rounded border border-gray-300 px-2 py-1 text-xs" onClick={() => execEditorCommand('insertUnorderedList')}>Liste</button>
                      <button type="button" className="rounded border border-gray-300 px-2 py-1 text-xs" onClick={insertEditorLink}>Link</button>
                      <button type="button" className="rounded border border-gray-300 px-2 py-1 text-xs" onClick={() => execEditorCommand('removeFormat')}>Ryd format</button>
                      <button
                        type="button"
                        className="ml-auto flex items-center gap-1 rounded border border-indigo-200 bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-100 active:scale-95 transition-all shrink-0"
                        onClick={() => openAiModalForField(descField.id)}
                      >
                        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
                        Generér
                      </button>
                    </div>
                    {mode === 'source' ? (
                      <textarea
                        className="h-64 w-full resize-none border-0 p-3 font-mono text-xs overflow-y-auto"
                        value={fieldEdits[descField.id] ?? ''}
                        onChange={(e) => setFieldEdits((prev) => ({ ...prev, [descField.id]: e.target.value }))}
                      />
                    ) : (
                      <div
                        ref={(el) => {
                          htmlEditorRefs.current[descField.id] = el;
                          if (el && htmlEditorDomValueRef.current[descField.id] === undefined) {
                            el.innerHTML = fieldEdits[descField.id] ?? '';
                            htmlEditorDomValueRef.current[descField.id] = fieldEdits[descField.id] ?? '';
                          }
                        }}
                        className="ep-richtext h-64 overflow-y-auto p-3 outline-none"
                        contentEditable
                        suppressContentEditableWarning
                        onInput={(e) => {
                          const html = e.currentTarget.innerHTML;
                          htmlEditorDomValueRef.current[descField.id] = html;
                          setFieldEdits((prev) => ({ ...prev, [descField.id]: html }));
                        }}
                      />
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Handle */}
            <div>
              <label htmlFor="handle-edit" className="block text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1.5">Handle</label>
              <input
                id="handle-edit"
                className="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-mono text-gray-700 focus:border-indigo-300 focus:bg-white focus:outline-none transition"
                value={handleEdit}
                onChange={(e) => setHandleEdit(e.target.value)}
              />
            </div>

          </div>
        )}
      </div>

      {/* Custom fields */}
      {customFields.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white">
          <div className="flex items-center gap-2 px-4 py-3 md:px-5 border-b border-gray-100">
            <span className="text-sm font-semibold text-gray-900">Felter</span>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">{customFields.length}</span>
          </div>
          <div className="px-4 pb-5 pt-4 md:px-5 space-y-5">
            {customFields.map((field) => {
              const mode = htmlEditorMode[field.id] ?? 'visual';
              return (
                <div key={field.id} className="text-sm">
                  <div className="flex items-center justify-between mb-1.5">
                    <label htmlFor={`field-${field.id}`} className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">
                      {field.label}
                      <span className="font-normal normal-case text-gray-300 tracking-normal">{field.type}</span>
                      {renderLockIcon(field.id, field.lockLevel)}
                    </label>
                    <button
                      type="button"
                      className="flex items-center gap-1 rounded border border-indigo-200 bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-100 transition"
                      onClick={() => openAiModalForField(field.id)}
                    >
                      <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
                      Generér
                    </button>
                  </div>
                  {field.type === 'html' ? (
                    <div className="rounded-lg border border-gray-300 bg-white">
                      <div className="flex flex-wrap items-center gap-1 border-b border-gray-200 p-2">
                        <button type="button" className={`rounded border px-2 py-1 text-xs ${mode === 'visual' ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-gray-300'}`} onClick={() => setHtmlEditorMode((prev) => ({ ...prev, [field.id]: 'visual' }))}>Visuel</button>
                        <button type="button" className={`rounded border px-2 py-1 text-xs ${mode === 'source' ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-gray-300'}`} onClick={() => setHtmlEditorMode((prev) => ({ ...prev, [field.id]: 'source' }))}>Kildekode</button>
                        <button type="button" className="rounded border border-gray-300 px-2 py-1 text-xs" onClick={() => execEditorCommand('bold')}>Fed</button>
                        <button type="button" className="rounded border border-gray-300 px-2 py-1 text-xs" onClick={() => execEditorCommand('italic')}>Kursiv</button>
                        <button type="button" className="rounded border border-gray-300 px-2 py-1 text-xs" onClick={() => execEditorCommand('insertUnorderedList')}>Liste</button>
                        <button type="button" className="rounded border border-gray-300 px-2 py-1 text-xs" onClick={insertEditorLink}>Link</button>
                        <button type="button" className="rounded border border-gray-300 px-2 py-1 text-xs" onClick={() => execEditorCommand('removeFormat')}>Ryd format</button>
                      </div>
                      {mode === 'source' ? (
                        <textarea
                          className={`h-48 w-full resize-none border-0 p-3 font-mono text-xs overflow-y-auto ${isFieldLockedForMe(field.lockLevel) ? 'bg-gray-50 cursor-not-allowed' : ''}`}
                          value={fieldEdits[field.id] ?? ''}
                          disabled={isFieldLockedForMe(field.lockLevel)}
                          onChange={(e) => setFieldEdits((prev) => ({ ...prev, [field.id]: e.target.value }))}
                        />
                      ) : (
                        <div
                          ref={(el) => {
                            htmlEditorRefs.current[field.id] = el;
                            if (el && htmlEditorDomValueRef.current[field.id] === undefined) {
                              el.innerHTML = fieldEdits[field.id] ?? '';
                              htmlEditorDomValueRef.current[field.id] = fieldEdits[field.id] ?? '';
                            }
                          }}
                          className={`ep-richtext h-48 overflow-y-auto p-3 outline-none ${isFieldLockedForMe(field.lockLevel) ? 'bg-gray-50 cursor-not-allowed' : ''}`}
                          contentEditable={!(isFieldLockedForMe(field.lockLevel))}
                          suppressContentEditableWarning
                          onInput={(e) => {
                            const html = e.currentTarget.innerHTML;
                            htmlEditorDomValueRef.current[field.id] = html;
                            setFieldEdits((prev) => ({ ...prev, [field.id]: html }));
                          }}
                        />
                      )}
                    </div>
                  ) : field.type === 'boolean' ? (
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                        checked={fieldEdits[field.id] === 'true'}
                        onChange={(e) => setFieldEdits((prev) => ({ ...prev, [field.id]: String(e.target.checked) }))}
                      />
                      <span className="text-sm text-gray-700">{field.label}</span>
                    </label>
                  ) : (
                    <input
                      id={`field-${field.id}`}
                      type={field.type === 'number' ? 'number' : 'text'}
                      className={`w-full rounded-lg border px-3 py-2 text-sm transition ${isFieldLockedForMe(field.lockLevel) ? 'border-gray-200 bg-gray-50 cursor-not-allowed text-gray-400' : 'border-gray-200 bg-gray-50 text-gray-700 focus:border-indigo-300 focus:bg-white focus:outline-none'}`}
                      value={fieldEdits[field.id] ?? ''}
                      disabled={isFieldLockedForMe(field.lockLevel)}
                      onChange={(e) => setFieldEdits((prev) => ({ ...prev, [field.id]: e.target.value }))}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {message && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">{message}</div>
      )}

      <section className="rounded-xl border border-gray-200 bg-white overflow-hidden">
        <button
          onClick={() => {
            setHistoryOpen((prev) => !prev);
            if (!historyOpen && !detailedHistory.length) {
              apiFetch<{ logs: HistoryLog[]; snapshots: HistorySnapshot[] }>(`/collections/${collection?.id}/history`)
                .then((res) => {
                  setDetailedHistory(res.logs);
                  setHistorySnapshots(res.snapshots);
                })
                .catch(() => {});
            }
          }}
          className="flex w-full items-center justify-between p-4 text-left md:px-5"
        >
          <div className="flex items-center gap-2">
            <svg viewBox="0 0 24 24" className="h-4 w-4 text-gray-500" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 8v4l3 3"/><circle cx="12" cy="12" r="10"/></svg>
            <span className="text-sm font-semibold text-gray-900">Historik</span>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500">{history.length}</span>
          </div>
          <svg viewBox="0 0 24 24" className={`h-4 w-4 text-gray-400 transition-transform ${historyOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6"/></svg>
        </button>

        {historyOpen && (
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
                {detailedHistory.map((log) => (
                  <div key={log.id} className="rounded-lg border border-gray-100 bg-gray-50/50 px-3 py-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-700">{log.source}</span>
                      <span className="text-gray-400">{new Date(log.createdAt).toLocaleString('da-DK')}</span>
                    </div>
                    {log.user && (
                      <div className="mt-1 text-gray-500">
                        {[log.user.firstName, log.user.lastName].filter(Boolean).join(' ') || log.user.email}
                      </div>
                    )}
                    {log.fieldKey && <div className="mt-1 font-mono text-gray-500">{log.fieldKey}</div>}
                  </div>
                ))}
              </div>
            )}

            {historyTab === 'snapshots' && (
              <div className="space-y-2 max-h-[500px] overflow-y-auto">
                {historySnapshots.length === 0 && <div className="text-sm text-gray-400">Ingen snapshots endnu.</div>}
                {historySnapshots.map((snap) => (
                  <details key={snap.id} className="rounded-lg border border-gray-100 bg-gray-50/50">
                    <summary className="cursor-pointer px-3 py-2 text-sm flex items-center gap-2">
                      <span className="shrink-0 rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-700">{snap.reason}</span>
                      <span className="text-gray-400 text-xs">{new Date(snap.createdAt).toLocaleString('da-DK')}</span>
                    </summary>
                    <pre className="overflow-x-auto px-3 pb-3 text-[11px] text-gray-600 whitespace-pre-wrap">{JSON.stringify(snap.blobJson, null, 2)}</pre>
                  </details>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Sticky save bar */}
      {hasUnsavedChanges && (
        <div className="fixed bottom-0 left-0 right-0 z-50 border-t border-indigo-100 bg-white/95 backdrop-blur-sm px-4 py-3 shadow-[0_-4px_24px_rgba(0,0,0,0.08)] md:left-[280px]">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="inline-block h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
              <span className="text-xs text-slate-600 font-medium">Ugemte ændringer</span>
              {draftSaveStatus === 'saving' && (
                <span className="inline-flex items-center gap-1 text-xs text-slate-400">
                  <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                  Auto-gemmer…
                </span>
              )}
              {draftSaveStatus === 'saved' && (
                <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
                  <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6 9 17l-5-5"/></svg>
                  Kladde gemt
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60 transition"
                disabled={isSaving}
                onClick={() => void saveCollection(false)}
              >
                {isSaving ? 'Gemmer…' : 'Gem kladde'}
              </button>
              <button
                className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60 transition shadow-sm"
                disabled={isSaving}
                onClick={() => void saveCollection(true)}
              >
                {isSaving ? 'Gemmer…' : 'Gem og synkronisér'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
