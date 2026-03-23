'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../../lib/api';
import { toast } from '../../../components/toaster';

type PromptTemplate = {
  id: string;
  name: string;
  body: string;
  category: string;
  targetType: string;
  tagsJson: string[];
  isDefault: boolean;
};

type QuickPreset = { label: string; instruction: string; scope?: 'product' | 'collection' };

const TARGET_OPTIONS = [
  { value: 'product', label: 'Produkt' },
  { value: 'collection', label: 'Kollektion' },
] as const;

const CATEGORY_OPTIONS = [
  'Produkt prompts',
  'SEO',
  'Beskrivelser',
  'Metadata',
  'Oversættelse',
  'Andet',
] as const;

const PRODUCT_VARIABLES = [
  { token: '{{title}}', description: 'Produkttitel' },
  { token: '{{handle}}', description: 'URL-venligt handle' },
  { token: '{{vendor}}', description: 'Leverandør/brand' },
  { token: '{{productType}}', description: 'Produkttype' },
  { token: '{{status}}', description: 'Shopify-status' },
  { token: '{{tags}}', description: 'Tags' },
  { token: '{{descriptionHtml}}', description: 'Produktbeskrivelse (HTML)' },
  { token: '{{sku}}', description: 'SKU (første variant)' },
  { token: '{{barcode}}', description: 'Stregkode' },
  { token: '{{price}}', description: 'Pris' },
  { token: '{{compareAtPrice}}', description: 'Sammenligningspris' },
  { token: '{{weight}}', description: 'Vægt' },
  { token: '{{weightUnit}}', description: 'Vægtenhed' },
  { token: '{{hsCode}}', description: 'HS-kode' },
  { token: '{{countryOfOrigin}}', description: 'Oprindelsesland' },
] as const;

const COLLECTION_VARIABLES = [
  { token: '{{title}}', description: 'Kollektionens titel' },
  { token: '{{handle}}', description: 'URL-venligt handle' },
  { token: '{{descriptionHtml}}', description: 'Kollektionsbeskrivelse (HTML)' },
] as const;

const DYNAMIC_VARIABLES_BY_TYPE: Record<string, ReadonlyArray<{ token: string; description: string }>> = {
  product: PRODUCT_VARIABLES,
  collection: COLLECTION_VARIABLES,
};

const DEFAULT_MASTER_PROMPT = `Du er en senior e-commerce copywriter og PIM-specialist.

Du modtager produktdata og skal generere en præcis feltværdi, der er:
- faktuel og udelukkende baseret på de data du modtager
- SEO-optimeret med naturligt sprog
- skrevet på dansk
- klar til publicering i en webshop
- fri for overdrivelser og usande claims

Regler:
1) Brug KUN data der er givet i input. Opfind ALDRIG information, tal, specifikationer eller egenskaber som ikke er eksplicit angivet.
2) Mangler der data til et felt, skriv hellere ingenting frem for at gætte.
3) Returnér kun den endelige feltværdi — ingen forklaringer, ingen præambel.

VIGTIGT: Du må ALDRIG opdigte, hallucinere eller gætte på noget som helst. Hellere ingen tekst end ukorrekt tekst.`;

const DEFAULT_QUICK_PRESETS: QuickPreset[] = [
  // Products
  { scope: 'product', label: 'Produktbeskrivelse', instruction: 'Skriv en overbevisende produktbeskrivelse der sætter kunden i centrum. Start med den vigtigste fordel. Beskriv hvad produktet gør, hvem det er til, og hvorfor det er det rigtige valg — uden at opfinde detaljer der ikke fremgår af data. Salgsstærkt, konkret og letlæseligt.' },
  { scope: 'product', label: 'Kort beskrivelse', instruction: 'Skriv 2-3 sætninger der fanger essensen: hvad er produktet, hvad gør det, og hvorfor købe det. Direkte, salgsstærkt, ingen fyld.' },
  { scope: 'product', label: 'Metatitel', instruction: `Generér en SEO-metatitel. STRENGT KRAV: Resultatet MÅ ABSOLUT IKKE overstige 60 tegn — tæl tegnene inden du returnerer. Primært søgeord tidligt i titlen, produktnavn med, naturligt og klikvenligt. Ingen marketing-snak, ingen udråbstegn. Hvis dit første udkast er over 60 tegn, skær ned og prøv igen.` },
  { scope: 'product', label: 'Metabeskrivelse', instruction: `Generér en SEO-metabeskrivelse. STRENGT KRAV: Resultatet SKAL være mellem 140 og 160 tegn — tæl tegnene inden du returnerer. Er dit udkast kortere end 140, udvid det. Er det over 160, skær ned. Tydelig kundeværdi + konkret call-to-action. Inkludér primært søgeord naturligt.` },
  { scope: 'product', label: 'FAQ', instruction: 'Generér 5 relevante FAQ-spørgsmål og svar om produktet. Brug kun data der er givet — gæt ikke på specifikationer.' },
  // Collections
  {
    scope: 'collection',
    label: 'Kollektionsbeskrivelse',
    instruction: `Skriv en engagerende, konverteringsoptimeret kollektionsbeskrivelse i HTML-format. Strukturér som 2-3 korte afsnit med <p>-tags. Første afsnit: hvad kollektionen indeholder og hvem den er til. Andet afsnit: de primære fordele og det, der adskiller kollektionen. Tredje afsnit (valgfrit): en stærk call-to-action. Skriv i et klart, tillidsfuldt sprog tilpasset brandets tone — undgå klichéer og tomme superlativer. Brug kun data der er givet.`,
  },
  {
    scope: 'collection',
    label: 'Metatitel',
    instruction: `Generér en SEO-metatitel til en kollektion. STRENGT KRAV: Resultatet MÅ ABSOLUT IKKE overstige 60 tegn — tæl tegnene inden du returnerer. Primært søgeord tidligt i titlen, kollektionsnavnet inkluderet, naturligt og klikvenligt. Ingen udråbstegn, ingen marketing-snak. Eksempelformat: "Herrejakker i læder | BrandNavn" eller "Sengetøj i øko-bomuld – Shop her". Hvis udkastet er over 60 tegn, skær ned og prøv igen.`,
  },
  {
    scope: 'collection',
    label: 'Metabeskrivelse',
    instruction: `Generér en SEO-metabeskrivelse til en kollektion. STRENGT KRAV: Resultatet SKAL være mellem 140 og 160 tegn — tæl tegnene inden du returnerer. Er udkastet kortere end 140 tegn, uddyb fordele eller tilføj call-to-action. Er det over 160 tegn, skær ned. Indhold: hvad kollektionen tilbyder, primær fordel for kunden, og ét konkret call-to-action (fx "Shop nu", "Se udvalget", "Find din størrelse"). Inkludér primært søgeord naturligt — ingen generiske sætninger.`,
  },
];

// Preset edit modal
function PresetEditModal({ preset, onSave, onClose }: {
  preset: QuickPreset;
  onSave: (updated: QuickPreset) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<QuickPreset>(preset);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <h3 className="text-base font-semibold text-slate-800">Rediger preset</h3>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">Navn</label>
              <input
                autoFocus
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-800 focus:border-indigo-300 focus:outline-none"
                value={draft.label}
                onChange={(e) => setDraft((p) => ({ ...p, label: e.target.value }))}
                placeholder="Navn på preset"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1.5">Scope</label>
              <select
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-300 focus:outline-none"
                value={draft.scope ?? 'product'}
                onChange={(e) => setDraft((p) => ({ ...p, scope: e.target.value as 'product' | 'collection' }))}
              >
                <option value="product">Produkter</option>
                <option value="collection">Kollektioner</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">Instruktion</label>
            <textarea
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-indigo-300 focus:outline-none resize-none"
              rows={6}
              value={draft.instruction}
              onChange={(e) => setDraft((p) => ({ ...p, instruction: e.target.value }))}
              placeholder="Instruktionen der sendes til AI…"
            />
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-slate-100">
          <button onClick={onClose} className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 transition">Annuller</button>
          <button
            className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 transition disabled:opacity-50"
            disabled={!draft.label.trim() || !draft.instruction.trim()}
            onClick={() => onSave(draft)}
          >
            Gem
          </button>
        </div>
      </div>
    </div>
  );
}

// Small confirmation modal
function ConfirmModal({ title, body, confirmLabel, confirmClass, onConfirm, onCancel }: {
  title: string; body: string; confirmLabel: string; confirmClass?: string; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onCancel}>
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-slate-800">{title}</h3>
        <p className="mt-2 text-sm text-slate-500 leading-relaxed">{body}</p>
        <div className="mt-5 flex gap-2 justify-end">
          <button onClick={onCancel} className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 transition">Annuller</button>
          <button onClick={onConfirm} className={`rounded-xl px-4 py-2 text-sm font-medium text-white transition ${confirmClass ?? 'bg-red-600 hover:bg-red-700'}`}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

export default function PromptsPage() {
  const [prompts, setPrompts] = useState<PromptTemplate[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [showVars, setShowVars] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{ name: string; body: string; category: string; targetType: string; tags: string; isDefault: boolean } | null>(null);
  const [form, setForm] = useState({ name: '', body: '', category: 'Produkt prompts', targetType: 'product', tags: '', isDefault: false });

  // Master prompt
  const [masterPrompt, setMasterPrompt] = useState<string | null>(null);
  const [masterPromptEdit, setMasterPromptEdit] = useState('');
  const [masterLocked, setMasterLocked] = useState(true);
  const [savingMaster, setSavingMaster] = useState(false);
  const [showMasterVars, setShowMasterVars] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);

  // AI introduction
  const [aiIntroduction, setAiIntroduction] = useState('');
  const [savingIntro, setSavingIntro] = useState(false);

  // Quick presets
  const [quickPresets, setQuickPresets] = useState<QuickPreset[]>(DEFAULT_QUICK_PRESETS);
  const [presetsFromServer, setPresetsFromServer] = useState(false);
  const [editingPresetIdx, setEditingPresetIdx] = useState<number | null>(null);
  const [savingPresets, setSavingPresets] = useState(false);
  const [addingPreset, setAddingPreset] = useState(false);
  const [newPreset, setNewPreset] = useState<QuickPreset>({ label: '', instruction: '', scope: 'product' });
  const [presetScopeTab, setPresetScopeTab] = useState<'product' | 'collection'>('product');

  const load = async (): Promise<void> => {
    try {
      const [promptsRes, aiSettingsRes] = await Promise.all([
        apiFetch<{ prompts: PromptTemplate[] }>('/prompts'),
        apiFetch<{ aiIntroduction: string; masterPrompt: string | null; quickPresets: QuickPreset[] | null }>('/shops/ai-settings').catch(() => ({ aiIntroduction: '', masterPrompt: null, quickPresets: null })),
      ]);
      setPrompts(promptsRes.prompts);
      setAiIntroduction(aiSettingsRes.aiIntroduction ?? '');
      setMasterPrompt(aiSettingsRes.masterPrompt ?? null);
      setMasterPromptEdit(aiSettingsRes.masterPrompt ?? DEFAULT_MASTER_PROMPT);
      if (aiSettingsRes.quickPresets) {
        const serverPresets = aiSettingsRes.quickPresets as QuickPreset[];
        // If server has no collection presets, inject the defaults so the tab isn't empty
        const hasCollectionPresets = serverPresets.some((p) => p.scope === 'collection');
        const merged = hasCollectionPresets
          ? serverPresets
          : [...serverPresets, ...DEFAULT_QUICK_PRESETS.filter((p) => p.scope === 'collection')];
        setQuickPresets(merged);
        setPresetsFromServer(true);
      }
    } catch {
      setPrompts([]);
    }
  };

  useEffect(() => { document.title = 'AI-prompts | ePIM'; void load(); }, []);

  const saveIntroduction = async (): Promise<void> => {
    setSavingIntro(true);
    try {
      await apiFetch('/shops/ai-settings', { method: 'PUT', body: JSON.stringify({ aiIntroduction }) });
      toast.success('Butiksintroduktion gemt.');
    } catch {
      toast.error('Kunne ikke gemme butiksintroduktion.');
    } finally {
      setSavingIntro(false);
    }
  };

  const saveMasterPrompt = async (): Promise<void> => {
    setSavingMaster(true);
    try {
      await apiFetch('/shops/ai-settings', { method: 'PUT', body: JSON.stringify({ masterPrompt: masterPromptEdit }) });
      setMasterPrompt(masterPromptEdit);
      setMasterLocked(true);
      toast.success('Masterprompt gemt.');
    } catch {
      toast.error('Kunne ikke gemme masterprompt.');
    } finally {
      setSavingMaster(false);
    }
  };

  const resetMasterPrompt = async (): Promise<void> => {
    setResetConfirm(false);
    setSavingMaster(true);
    try {
      await apiFetch('/shops/ai-settings', { method: 'PUT', body: JSON.stringify({ masterPrompt: null }) });
      setMasterPrompt(null);
      setMasterPromptEdit(DEFAULT_MASTER_PROMPT);
      setMasterLocked(true);
      toast.success('Masterprompt nulstillet til standard.');
    } catch {
      toast.error('Kunne ikke nulstille masterprompt.');
    } finally {
      setSavingMaster(false);
    }
  };

  const savePresets = async (presets: QuickPreset[]): Promise<void> => {
    setSavingPresets(true);
    try {
      await apiFetch('/shops/ai-settings', { method: 'PUT', body: JSON.stringify({ quickPresets: presets }) });
      setQuickPresets(presets);
      setPresetsFromServer(true);
      toast.success('Hurtig-presets gemt.');
    } catch {
      toast.error('Kunne ikke gemme presets.');
    } finally {
      setSavingPresets(false);
    }
  };

  const resetForm = (): void => {
    setForm({ name: '', body: '', category: 'Produkt prompts', targetType: 'product', tags: '', isDefault: false });
  };

  const createPrompt = async (): Promise<void> => {
    if (!form.name.trim() || !form.body.trim()) { toast.error('Angiv navn og prompt-tekst.'); return; }
    try {
      await apiFetch('/prompts', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          body: form.body,
          category: form.category,
          targetType: form.targetType,
          tagsJson: form.tags.split(',').map((item) => item.trim()).filter(Boolean),
          isDefault: form.isDefault,
        }),
      });
      resetForm();
      setShowForm(false);
      toast.success('Prompt oprettet.');
      void load();
    } catch {
      toast.error('Kunne ikke gemme prompt.');
    }
  };

  const saveEditPrompt = async (id: string): Promise<void> => {
    if (!editForm) return;
    try {
      await apiFetch(`/prompts/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editForm.name,
          body: editForm.body,
          category: editForm.category,
          targetType: editForm.targetType,
          tagsJson: editForm.tags.split(',').map((t) => t.trim()).filter(Boolean),
          isDefault: editForm.isDefault,
        }),
      });
      setEditingId(null);
      setEditForm(null);
      toast.success('Prompt opdateret.');
      void load();
    } catch {
      toast.error('Kunne ikke opdatere prompt.');
    }
  };

  const deletePrompt = async (id: string, name: string): Promise<void> => {
    if (!window.confirm(`Slet prompt "${name}"?`)) return;
    try {
      await apiFetch(`/prompts/${id}`, { method: 'DELETE' });
      toast.success('Prompt slettet.');
      if (expandedId === id) setExpandedId(null);
      void load();
    } catch {
      toast.error('Kunne ikke slette prompt.');
    }
  };

  const grouped = prompts.reduce<Record<string, PromptTemplate[]>>((acc, p) => {
    const key = p.category || 'Uden kategori';
    (acc[key] ??= []).push(p);
    return acc;
  }, {});

  const isCustomMaster = masterPrompt !== null;

  return (
    <div className="space-y-5 max-w-3xl">
      {resetConfirm && (
        <ConfirmModal
          title="Nulstil masterprompt?"
          body="Dette nulstiller masterprompt til standardteksten. Din nuværende version slettes permanent."
          confirmLabel="Nulstil"
          onConfirm={() => void resetMasterPrompt()}
          onCancel={() => setResetConfirm(false)}
        />
      )}

      {editingPresetIdx !== null && quickPresets[editingPresetIdx] && (
        <PresetEditModal
          preset={quickPresets[editingPresetIdx]}
          onSave={(updated) => {
            const newPresets = quickPresets.map((p, i) => i === editingPresetIdx ? updated : p);
            void savePresets(newPresets);
            setEditingPresetIdx(null);
          }}
          onClose={() => setEditingPresetIdx(null)}
        />
      )}

      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-slate-900">AI-prompts</h1>
        <p className="text-sm text-slate-500 mt-1">Tilpas AI-genereringen med masterprompt, butikskontekst og egne skabeloner.</p>
      </div>

      {/* ── Master Prompt ── */}
      <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100">
              <svg viewBox="0 0 24 24" className="h-4 w-4 text-slate-600" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2a5 5 0 0 1 5 5v3H7V7a5 5 0 0 1 5-5z"/><rect x="3" y="10" width="18" height="12" rx="2"/><circle cx="12" cy="16" r="1.5" fill="currentColor"/></svg>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-slate-800">Masterprompt</span>
                {!isCustomMaster && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">Standard</span>}
                {isCustomMaster && <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-medium text-indigo-700">Tilpasset</span>}
              </div>
              <p className="text-xs text-slate-400 mt-0.5">Grundlaget for <em>alle</em> AI-genereringer i din butik</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setMasterLocked((v) => !v)}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
              masterLocked
                ? 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100'
                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            {masterLocked ? (
              <>
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                Lås op for redigering
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></svg>
                Lås igen
              </>
            )}
          </button>
        </div>

        {/* Warning banner — always visible */}
        <div className="flex items-start gap-3 bg-amber-50 border-b border-amber-100 px-5 py-3">
          <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-amber-500 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>
          <p className="text-xs text-amber-700 leading-relaxed">
            <strong>Forsigtig.</strong> Masterprompt styrer AI-rollens grundadfærd ved <em>alle</em> genereringer. Forkerte ændringer kan medføre dårlig output-kvalitet, hallucination eller at AI ignorerer dine instrukser. Rediger kun hvis du ved hvad du gør — eller nulstil til standard.
          </p>
        </div>

        <div className="px-5 py-4 space-y-3">
          <textarea
            className={`w-full rounded-xl border px-3 py-2.5 text-sm font-mono leading-relaxed transition resize-y ${
              masterLocked
                ? 'border-slate-200 bg-slate-50 text-slate-400 cursor-not-allowed select-none'
                : 'border-slate-300 bg-white text-slate-700 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 focus:outline-none'
            }`}
            rows={12}
            value={masterPromptEdit}
            disabled={masterLocked}
            onChange={(e) => setMasterPromptEdit(e.target.value)}
          />

          {!masterLocked && (
            <div>
              <button type="button" className="text-xs text-indigo-600 hover:underline" onClick={() => setShowMasterVars((v) => !v)}>
                {showMasterVars ? 'Skjul variabler' : 'Vis dynamiske variabler'}
              </button>
              {showMasterVars && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {PRODUCT_VARIABLES.map(({ token, description }) => (
                    <button key={token} type="button" title={description}
                      className="rounded-md border border-slate-200 bg-white px-2 py-0.5 font-mono text-xs text-slate-600 hover:border-indigo-300 hover:bg-indigo-50 transition"
                      onClick={() => setMasterPromptEdit((prev) => `${prev} ${token}`)}
                    >{token}</button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex items-center justify-between pt-1">
            <button type="button"
              className="text-xs text-slate-400 hover:text-red-500 transition disabled:opacity-40"
              disabled={savingMaster}
              onClick={() => setResetConfirm(true)}
            >
              Nulstil til standard
            </button>
            {!masterLocked && (
              <button className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 transition disabled:opacity-50" disabled={savingMaster} onClick={() => void saveMasterPrompt()}>
                {savingMaster ? 'Gemmer…' : 'Gem masterprompt'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Butiksintroduktion ── */}
      <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-slate-100">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100">
            <svg viewBox="0 0 24 24" className="h-4 w-4 text-slate-600" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          </div>
          <div>
            <span className="text-sm font-semibold text-slate-800">Butiksintroduktion</span>
            <p className="text-xs text-slate-400 mt-0.5">Kontekst om webshoppen — sendes med til AI som baggrundsviden</p>
          </div>
        </div>
        <div className="px-5 py-4 space-y-3">
          <textarea
            className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 placeholder:text-slate-400 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100 focus:outline-none transition resize-none"
            rows={4}
            placeholder="Fx: Vi er en dansk webshop der sælger premium udendørsmøbler til private. Vores tone of voice er venlig og professionel. Vi skriver altid på dansk og henvender os til kunder i Skandinavien."
            value={aiIntroduction}
            onChange={(e) => setAiIntroduction(e.target.value)}
          />
          <div className="flex justify-end">
            <button className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 transition disabled:opacity-50" disabled={savingIntro} onClick={() => void saveIntroduction()}>
              {savingIntro ? 'Gemmer…' : 'Gem introduktion'}
            </button>
          </div>
        </div>
      </div>

      {/* ── Hurtig-presets ── */}
      <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100">
              <svg viewBox="0 0 24 24" className="h-4 w-4 text-slate-600" fill="none" stroke="currentColor" strokeWidth="2"><path d="m13 2-2 2.5h3L12 7"/><path d="M10 14v-3"/><path d="M14 14v-3"/><path d="M11 19H6.5a3.5 3.5 0 1 1 0-7H12"/><path d="M13 19a4 4 0 0 0 4-4V9h-1a4 4 0 0 0-4 4"/></svg>
            </div>
            <div>
              <span className="text-sm font-semibold text-slate-800">Hurtig-presets</span>
              <p className="text-xs text-slate-400 mt-0.5">Klik-for-indsæt instrukser i AI-modalvinduet på produkt- og kollektionssider</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!presetsFromServer && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-400">Standard</span>
            )}
            <div className="flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 gap-0.5">
              {(['product', 'collection'] as const).map((s) => (
                <button
                  key={s}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition ${presetScopeTab === s ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                  onClick={() => { setPresetScopeTab(s); setAddingPreset(false); }}
                >
                  {s === 'product' ? 'Produkter' : 'Kollektioner'}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="divide-y divide-slate-100">
          {quickPresets.filter((p) => (p.scope ?? 'product') === presetScopeTab).map((preset) => {
            const idx = quickPresets.indexOf(preset);
            return (
              <div
                key={idx}
                className="flex items-start justify-between gap-3 px-5 py-3 group cursor-pointer hover:bg-slate-50 transition"
                onClick={() => setEditingPresetIdx(idx)}
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-800">{preset.label}</div>
                  <div className="mt-0.5 text-xs text-slate-400 leading-relaxed line-clamp-2">{preset.instruction}</div>
                </div>
                <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition">
                  <button
                    className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-400 hover:text-indigo-600 hover:border-indigo-200 transition"
                    title="Rediger"
                    onClick={(e) => { e.stopPropagation(); setEditingPresetIdx(idx); }}
                  >
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                  </button>
                  <button
                    className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-400 hover:text-red-500 hover:border-red-200 transition"
                    title="Slet"
                    onClick={(e) => {
                      e.stopPropagation();
                      const updated = quickPresets.filter((_, i) => i !== idx);
                      void savePresets(updated);
                    }}
                  >
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                  </button>
                </div>
              </div>
            );
          })}
          {quickPresets.filter((p) => (p.scope ?? 'product') === presetScopeTab).length === 0 && !addingPreset && (
            <div className="px-5 py-6 text-center text-sm text-slate-400">Ingen presets for {presetScopeTab === 'product' ? 'produkter' : 'kollektioner'} endnu.</div>
          )}

          {/* Add new preset */}
          {addingPreset ? (
            <div className="px-5 py-3 space-y-2 bg-indigo-50/50">
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  className="flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-800 focus:border-indigo-300 focus:outline-none"
                  value={newPreset.label}
                  onChange={(e) => setNewPreset((p) => ({ ...p, label: e.target.value }))}
                  placeholder="Navn på preset, fx 'Bullet points'"
                />
                <select
                  className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm focus:border-indigo-300 focus:outline-none"
                  value={newPreset.scope ?? presetScopeTab}
                  onChange={(e) => setNewPreset((p) => ({ ...p, scope: e.target.value as 'product' | 'collection' }))}
                >
                  <option value="product">Produkter</option>
                  <option value="collection">Kollektioner</option>
                </select>
              </div>
              <textarea
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-indigo-300 focus:outline-none resize-none"
                rows={3}
                value={newPreset.instruction}
                onChange={(e) => setNewPreset((p) => ({ ...p, instruction: e.target.value }))}
                placeholder="Instruktion til AI…"
              />
              <div className="flex items-center gap-2">
                <button
                  className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 transition disabled:opacity-50"
                  disabled={savingPresets || !newPreset.label.trim() || !newPreset.instruction.trim()}
                  onClick={() => {
                    const updated = [...quickPresets, { label: newPreset.label.trim(), instruction: newPreset.instruction.trim(), scope: newPreset.scope ?? presetScopeTab }];
                    void savePresets(updated);
                    setNewPreset({ label: '', instruction: '', scope: presetScopeTab });
                    setAddingPreset(false);
                  }}
                >
                  Tilføj
                </button>
                <button className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-50 transition" onClick={() => { setAddingPreset(false); setNewPreset({ label: '', instruction: '', scope: presetScopeTab }); }}>
                  Annuller
                </button>
              </div>
            </div>
          ) : (
            <div className="px-5 py-3">
              <button
                className="flex items-center gap-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-800 transition"
                onClick={() => { setAddingPreset(true); setNewPreset({ label: '', instruction: '', scope: presetScopeTab }); }}
              >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14"/></svg>
                Nyt {presetScopeTab === 'product' ? 'produkt' : 'kollektions'}-preset
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Prompt-skabeloner ── */}
      <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100">
              <svg viewBox="0 0 24 24" className="h-4 w-4 text-slate-600" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
            </div>
            <div>
              <span className="text-sm font-semibold text-slate-800">Prompt-skabeloner</span>
              <p className="text-xs text-slate-400 mt-0.5">Vælgbare templates i AI-modalvinduet</p>
            </div>
          </div>
          <button
            onClick={() => { setShowForm(!showForm); if (showForm) resetForm(); }}
            className={`flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium transition ${showForm ? 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50' : 'bg-indigo-600 text-white hover:bg-indigo-700'}`}
          >
            {showForm ? 'Annuller' : <><svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14"/></svg> Ny skabelon</>}
          </button>
        </div>

        {/* Create form */}
        {showForm && (
          <div className="border-b border-slate-100 bg-slate-50/50 px-5 py-4 space-y-4">
            <h3 className="text-sm font-semibold text-slate-700">Ny prompt-skabelon</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-600">Navn <span className="text-red-400">*</span></label>
                <input className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-300 focus:outline-none" placeholder="SEO-titel generator" value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-600">Kategori</label>
                <select className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-300 focus:outline-none" value={form.category} onChange={(e) => setForm((p) => ({ ...p, category: e.target.value }))}>
                  {CATEGORY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-600">Måltype</label>
                <select className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-300 focus:outline-none" value={form.targetType} onChange={(e) => setForm((p) => ({ ...p, targetType: e.target.value }))}>
                  {TARGET_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-600">Tags</label>
                <input className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-300 focus:outline-none" placeholder="seo, titel — kommasepareret" value={form.tags} onChange={(e) => setForm((p) => ({ ...p, tags: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-slate-600">Prompt-tekst <span className="text-red-400">*</span></label>
                <button type="button" onClick={() => setShowVars(!showVars)} className="text-xs text-indigo-600 hover:underline">{showVars ? 'Skjul variabler' : 'Vis variabler'}</button>
              </div>
              {showVars && (
                <div className="rounded-lg border border-indigo-100 bg-indigo-50/50 p-3">
                  <p className="text-xs font-medium text-indigo-700 mb-2">Klik for at indsætte:</p>
                  <div className="flex flex-wrap gap-1.5">
                    {(DYNAMIC_VARIABLES_BY_TYPE[form.targetType] ?? PRODUCT_VARIABLES).map((v) => (
                      <button key={v.token} type="button" onClick={() => setForm((p) => ({ ...p, body: p.body + v.token }))}
                        className="group inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-white px-2 py-1 text-xs transition hover:border-indigo-400 hover:bg-indigo-50" title={v.description}>
                        <code className="font-mono text-indigo-700">{v.token}</code>
                        <span className="text-slate-400 group-hover:text-slate-600">{v.description}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <textarea className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-mono focus:border-indigo-300 focus:outline-none resize-y" rows={5}
                placeholder={"Skriv en SEO-optimeret titel for {{title}}.\nMax 60 tegn."}
                value={form.body} onChange={(e) => setForm((p) => ({ ...p, body: e.target.value }))} />
            </div>
            <div className="flex items-center justify-between">
              <label className="inline-flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
                <input type="checkbox" className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" checked={form.isDefault} onChange={(e) => setForm((p) => ({ ...p, isDefault: e.target.checked }))} />
                Brug som standardprompt for måltypen
              </label>
              <button className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 transition" onClick={() => void createPrompt()}>Gem skabelon</button>
            </div>
          </div>
        )}

        {/* List */}
        {prompts.length === 0 && !showForm ? (
          <div className="flex flex-col items-center justify-center px-5 py-12 text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100">
              <svg className="h-6 w-6 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" /></svg>
            </div>
            <p className="text-sm font-medium text-slate-600">Ingen skabeloner endnu</p>
            <p className="mt-1 text-xs text-slate-400">Opret din første prompt-skabelon til AI-generering.</p>
            <button onClick={() => setShowForm(true)} className="mt-4 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 transition">+ Opret skabelon</button>
          </div>
        ) : (
          <div>
            {Object.entries(grouped).map(([category, items]) => (
              <div key={category}>
                <div className="flex items-center gap-2 px-5 py-2 bg-slate-50/70 border-b border-slate-100">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">{category}</span>
                  <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500">{items.length}</span>
                </div>
                {items.map((prompt) => (
                  <div key={prompt.id} className="border-b border-slate-100 last:border-0">
                    <button type="button"
                      className="flex w-full items-center justify-between px-5 py-3 text-left hover:bg-slate-50/70 transition-colors"
                      onClick={() => {
                        if (expandedId === prompt.id) { setExpandedId(null); setEditingId(null); setEditForm(null); }
                        else { setExpandedId(prompt.id); setEditingId(null); setEditForm(null); }
                      }}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="font-medium text-slate-800 truncate text-sm">{prompt.name}</span>
                        {prompt.isDefault && <span className="shrink-0 rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700">Standard</span>}
                        <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{TARGET_OPTIONS.find((o) => o.value === prompt.targetType)?.label ?? prompt.targetType}</span>
                        {(prompt.tagsJson ?? []).length > 0 && (
                          <div className="hidden sm:flex items-center gap-1">
                            {prompt.tagsJson.slice(0, 3).map((tag) => <span key={tag} className="rounded bg-slate-50 border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500">{tag}</span>)}
                            {prompt.tagsJson.length > 3 && <span className="text-[10px] text-slate-400">+{prompt.tagsJson.length - 3}</span>}
                          </div>
                        )}
                      </div>
                      <svg className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${expandedId === prompt.id ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>

                    {expandedId === prompt.id && (
                      <div className="border-t border-slate-100 bg-slate-50/30 px-5 py-4 space-y-3">
                        {editingId === prompt.id && editForm ? (
                          /* ── Edit form ── */
                          <div className="space-y-3">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              <div className="space-y-1">
                                <label className="text-xs font-medium text-slate-600">Navn</label>
                                <input className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-300 focus:outline-none" value={editForm.name} onChange={(e) => setEditForm((p) => p ? { ...p, name: e.target.value } : p)} />
                              </div>
                              <div className="space-y-1">
                                <label className="text-xs font-medium text-slate-600">Kategori</label>
                                <select className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-300 focus:outline-none" value={editForm.category} onChange={(e) => setEditForm((p) => p ? { ...p, category: e.target.value } : p)}>
                                  {CATEGORY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                                </select>
                              </div>
                              <div className="space-y-1">
                                <label className="text-xs font-medium text-slate-600">Måltype</label>
                                <select className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-300 focus:outline-none" value={editForm.targetType} onChange={(e) => setEditForm((p) => p ? { ...p, targetType: e.target.value } : p)}>
                                  {TARGET_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </select>
                              </div>
                              <div className="space-y-1">
                                <label className="text-xs font-medium text-slate-600">Tags</label>
                                <input className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-300 focus:outline-none" placeholder="kommasepareret" value={editForm.tags} onChange={(e) => setEditForm((p) => p ? { ...p, tags: e.target.value } : p)} />
                              </div>
                            </div>
                            <div className="space-y-1">
                              <label className="text-xs font-medium text-slate-600">Prompt-tekst</label>
                              <textarea className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-mono focus:border-indigo-300 focus:outline-none resize-y" rows={6} value={editForm.body} onChange={(e) => setEditForm((p) => p ? { ...p, body: e.target.value } : p)} />
                            </div>
                            <div className="flex items-center justify-between">
                              <label className="inline-flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
                                <input type="checkbox" className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" checked={editForm.isDefault} onChange={(e) => setEditForm((p) => p ? { ...p, isDefault: e.target.checked } : p)} />
                                Standardprompt for måltypen
                              </label>
                              <div className="flex gap-2">
                                <button className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 transition" onClick={() => { setEditingId(null); setEditForm(null); }}>Annuller</button>
                                <button className="rounded-xl bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 transition" onClick={() => void saveEditPrompt(prompt.id)}>Gem ændringer</button>
                              </div>
                            </div>
                          </div>
                        ) : (
                          /* ── View ── */
                          <>
                            <pre className="whitespace-pre-wrap rounded-xl bg-white border border-slate-100 p-3 text-sm text-slate-700 font-mono leading-relaxed">{prompt.body}</pre>
                            <div className="flex items-center justify-between">
                              <div className="flex flex-wrap gap-1.5">
                                {(prompt.tagsJson ?? []).map((tag) => <span key={tag} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">{tag}</span>)}
                              </div>
                              <div className="flex items-center gap-2">
                                <button
                                  className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 transition"
                                  onClick={() => {
                                    setEditingId(prompt.id);
                                    setEditForm({ name: prompt.name, body: prompt.body, category: prompt.category, targetType: prompt.targetType, tags: (prompt.tagsJson ?? []).join(', '), isDefault: prompt.isDefault });
                                  }}
                                >
                                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                                  Rediger
                                </button>
                                <button
                                  className="flex items-center gap-1.5 rounded-xl border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 transition"
                                  onClick={() => void deletePrompt(prompt.id, prompt.name)}
                                >
                                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                                  Slet
                                </button>
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
