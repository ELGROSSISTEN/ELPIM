'use client';

import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { apiFetch } from '../../lib/api';
import { registerBackgroundActivityJobs } from '../../lib/background-activity';

const SHOPIFY_FIELD_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'ignore', label: '— Spring over —' },
  { value: 'title', label: 'Produkttitel' },
  { value: 'handle', label: 'Handle (URL-slug)' },
  { value: 'descriptionHtml', label: 'Beskrivelse (HTML)' },
  { value: 'vendor', label: 'Leverandør/brand' },
  { value: 'productType', label: 'Produkttype' },
  { value: 'status', label: 'Status (ACTIVE/DRAFT/ARCHIVED)' },
  { value: 'tags', label: 'Tags (kommasepareret)' },
  { value: 'price', label: 'Pris' },
  { value: 'compareAtPrice', label: 'Sammenlign-pris' },
  { value: 'sku', label: 'Varenummer (SKU)' },
  { value: 'barcode', label: 'Stregkode/EAN' },
  { value: 'weight', label: 'Vægt (gram)' },
  { value: 'shopifyId', label: 'Shopify Produkt-ID' },
];

type ConflictPolicy = 'update' | 'skip' | 'create_new';

type Step = 'idle' | 'analyzing' | 'mapping' | 'preview' | 'importing' | 'done' | 'failed';
type JobStatus = 'idle' | 'queued' | 'running' | 'done' | 'failed';

type AnalyzeResult = {
  headers: string[];
  separator: string;
  rowCount: number;
  columnMap: Record<string, string>;
  needsReview: boolean;
  notes: string;
  previewRows: Array<Record<string, string>>;
};

type ImportResult = { created: number; updated: number; failed: number; errors: string[] };

export default function ImportsPage() {
  const [step, setStep] = useState<Step>('idle');
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [analyzeResult, setAnalyzeResult] = useState<AnalyzeResult | null>(null);
  const [columnMap, setColumnMap] = useState<Record<string, string>>({});
  const [jobId, setJobId] = useState('');
  const [jobStatus, setJobStatus] = useState<JobStatus>('idle');
  const [jobError, setJobError] = useState('');
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [conflictPolicy, setConflictPolicy] = useState<ConflictPolicy>('update');
  const [analyzeError, setAnalyzeError] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { document.title = 'Import | ePIM'; }, []);

  // Poll while job is running
  useEffect(() => {
    if (!jobId || jobStatus === 'done' || jobStatus === 'failed' || jobStatus === 'idle') return;
    const id = setInterval(async () => {
      try {
        const res = await apiFetch<{ job: { status: string; error?: string | null; payloadJson?: unknown } }>(`/import/${jobId}`);
        const s = res.job.status as JobStatus;
        setJobStatus(s);
        if (res.job.error) setJobError(res.job.error);
        if (s === 'done') {
          const payload = res.job.payloadJson as { result?: ImportResult } | null;
          if (payload?.result) setImportResult(payload.result);
          setStep('done');
          clearInterval(id);
        } else if (s === 'failed') {
          setStep('failed');
          clearInterval(id);
        }
      } catch {
        clearInterval(id);
      }
    }, 1500);
    return () => clearInterval(id);
  }, [jobId, jobStatus]);

  const loadFile = (file: File): void => {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => setCsv(String(e.target?.result ?? ''));
    reader.readAsText(file);
  };

  const onFileChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (file) loadFile(file);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) loadFile(file);
  };

  const analyzeFile = async (): Promise<void> => {
    if (!csv.trim()) return;
    setAnalyzeError('');
    setStep('analyzing');
    try {
      const result = await apiFetch<AnalyzeResult>('/import/analyze', {
        method: 'POST',
        body: JSON.stringify({ csv }),
      });
      setAnalyzeResult(result);
      setColumnMap(result.columnMap);
      setStep('mapping');
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : 'AI analyse fejlede');
      setStep('idle');
    }
  };

  const startImport = async (): Promise<void> => {
    if (!csv.trim()) return;
    setJobError('');
    setJobStatus('queued');
    setStep('importing');
    try {
      const res = await apiFetch<{ jobId: string }>('/import.csv', {
        method: 'POST',
        body: JSON.stringify({ csv, columnMap, conflictPolicy }),
      });
      setJobId(res.jobId);
      registerBackgroundActivityJobs([res.jobId]);
    } catch (err) {
      setJobError(err instanceof Error ? err.message : 'Import fejlede');
      setStep('failed');
    }
  };

  const reset = (): void => {
    setStep('idle');
    setCsv('');
    setFileName('');
    setAnalyzeResult(null);
    setColumnMap({});
    setConflictPolicy('update');
    setJobId('');
    setJobStatus('idle');
    setJobError('');
    setImportResult(null);
    setAnalyzeError('');
    if (fileRef.current) fileRef.current.value = '';
  };

  // --- RENDER ---

  if (step === 'done') {
    return (
      <div className="space-y-4">
        <div className="ep-card-strong p-4 md:p-5">
          <h1 className="ep-title">Importer produkter</h1>
        </div>
        <div className="ep-card p-6 space-y-4 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100">
            <svg className="h-7 w-7 text-emerald-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-slate-800">Import afsluttet</h2>
          {importResult && (
            <div className="flex items-center justify-center gap-6 text-sm">
              <span className="text-emerald-700"><strong>{importResult.created}</strong> oprettet</span>
              <span className="text-indigo-700"><strong>{importResult.updated}</strong> opdateret</span>
              {importResult.failed > 0 && <span className="text-red-600"><strong>{importResult.failed}</strong> fejlet</span>}
            </div>
          )}
          {importResult?.errors && importResult.errors.length > 0 && (
            <details className="text-left">
              <summary className="cursor-pointer text-xs text-slate-500">Vis fejl ({importResult.errors.length})</summary>
              <ul className="mt-2 space-y-1">
                {importResult.errors.map((e, i) => (
                  <li key={i} className="rounded bg-red-50 px-2 py-1 text-xs text-red-700">{e}</li>
                ))}
              </ul>
            </details>
          )}
          <div className="flex justify-center gap-3 pt-2">
            <a href="/dashboard/products" className="ep-btn-primary text-sm">Se produkter</a>
            <button onClick={reset} className="ep-btn-secondary text-sm">Importer ny fil</button>
          </div>
        </div>
      </div>
    );
  }

  if (step === 'failed') {
    return (
      <div className="space-y-4">
        <div className="ep-card-strong p-4 md:p-5">
          <h1 className="ep-title">Importer produkter</h1>
        </div>
        <div className="ep-card p-6 space-y-4 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-red-100">
            <svg className="h-7 w-7 text-red-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" /><path d="M12 8v4m0 4h.01" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-slate-800">Import fejlede</h2>
          {jobError && <p className="text-sm text-red-600">{jobError}</p>}
          <button onClick={reset} className="ep-btn-secondary">Prøv igen</button>
        </div>
      </div>
    );
  }

  if (step === 'importing') {
    return (
      <div className="space-y-4">
        <div className="ep-card-strong p-4 md:p-5">
          <h1 className="ep-title">Importer produkter</h1>
        </div>
        <div className="ep-card p-8 flex flex-col items-center gap-4">
          <div className="h-10 w-10 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
          <p className="text-sm font-medium text-slate-700">Importerer produkter…</p>
          <p className="text-xs text-slate-400">Dette kan tage et øjeblik. Lad siden være åben.</p>
        </div>
      </div>
    );
  }

  if (step === 'preview' && analyzeResult) {
    const previewHeaders = analyzeResult.headers
      .filter((h) => columnMap[h] && columnMap[h] !== 'ignore')
      .slice(0, 8);

    return (
      <div className="space-y-4">
        <div className="ep-card-strong p-4 md:p-5">
          <h1 className="ep-title">Importer produkter</h1>
          <p className="ep-subtitle mt-1">Trin 3 af 3 — Bekræft import</p>
        </div>

        {/* BETA warning */}
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 space-y-1">
          <div className="flex items-center gap-2 text-amber-800 font-semibold text-sm">
            <svg className="h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            BETA — Gennemgå dataen grundigt
          </div>
          <p className="text-xs text-amber-700">
            Import-funktionen er i BETA. Tjek venligst produktdataen nedenfor grundigt, inden du bekræfter.{' '}
            <strong>Gå til Shopify Admin → Produkter → Eksporter</strong> og tag en sikkerhedskopi af dine produkter, inden du fortsætter.
          </p>
        </div>

        {/* Conflict policy */}
        <div className="ep-card p-4 space-y-3">
          <div className="text-sm font-medium text-slate-700">Hvad skal der ske, hvis en SKU allerede findes i din butik?</div>
          <div className="space-y-2">
            {([
              { value: 'update', label: 'Opdater eksisterende produkt', desc: 'Overskriver titel, beskrivelse og andre felter for produkter med samme SKU.' },
              { value: 'skip', label: 'Spring over eksisterende', desc: 'Produkter med en allerede-eksisterende SKU springes over — kun nye importeres.' },
              { value: 'create_new', label: 'Opret altid nyt produkt', desc: 'Der oprettes altid et nyt produkt, selvom SKU\'en allerede findes.' },
            ] as { value: ConflictPolicy; label: string; desc: string }[]).map((opt) => (
              <label key={opt.value} className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition ${conflictPolicy === opt.value ? 'border-indigo-300 bg-indigo-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}>
                <input
                  type="radio"
                  name="conflictPolicy"
                  value={opt.value}
                  checked={conflictPolicy === opt.value}
                  onChange={() => setConflictPolicy(opt.value)}
                  className="mt-0.5 accent-indigo-600"
                />
                <div>
                  <div className="text-sm font-medium text-slate-800">{opt.label}</div>
                  <div className="text-xs text-slate-500">{opt.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Preview table */}
        <div className="ep-card p-4 space-y-2">
          <div className="text-sm font-medium text-slate-700">
            Forhåndsvisning — {analyzeResult.rowCount} rækker ({analyzeResult.previewRows.length} vist)
          </div>
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50">
                <tr>
                  {previewHeaders.map((h) => (
                    <th key={h} className="px-3 py-2 text-left font-medium text-slate-600 whitespace-nowrap">
                      {h}
                      <span className="ml-1 text-indigo-500">→ {columnMap[h]}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {analyzeResult.previewRows.map((row, i) => (
                  <tr key={i} className="hover:bg-slate-50">
                    {previewHeaders.map((h) => (
                      <td key={h} className="px-3 py-1.5 text-slate-700 max-w-[200px] truncate" title={row[h]}>
                        {row[h] || <span className="text-slate-300">—</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {analyzeResult.rowCount > analyzeResult.previewRows.length && (
            <p className="text-xs text-slate-400">+ {analyzeResult.rowCount - analyzeResult.previewRows.length} flere rækker vises ikke i forhåndsvisning</p>
          )}
        </div>

        {/* "Nothing happens until confirm" note */}
        <div className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-500">
          <svg className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/></svg>
          <span>Ingen ændringer foretages i Shopify, før du klikker <strong className="text-slate-700">"Bekræft og importér"</strong> nedenfor. Du kan stadig gå tilbage og justere kortlægningen.</span>
        </div>

        <div className="flex items-center gap-3">
          <button className="ep-btn-primary" onClick={() => void startImport()}>
            Bekræft og importér {analyzeResult.rowCount} produkter
          </button>
          <button className="ep-btn-secondary" onClick={() => setStep('mapping')}>
            ← Tilbage til kortlægning
          </button>
        </div>
      </div>
    );
  }

  if (step === 'mapping' && analyzeResult) {
    return (
      <div className="space-y-4">
        <div className="ep-card-strong p-4 md:p-5">
          <h1 className="ep-title">Importer produkter</h1>
          <p className="ep-subtitle mt-1">Trin 2 af 3 — Kortlæg kolonner</p>
        </div>

        {analyzeResult.needsReview && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <strong>AI er usikker på kortlægningen</strong> — gennemgå venligst kortlægningen nedenfor, inden du fortsætter.
            {analyzeResult.notes && <p className="mt-1 text-xs">{analyzeResult.notes}</p>}
          </div>
        )}

        <div className="ep-card p-4 space-y-3">
          <div className="text-sm font-medium text-slate-700">
            Kortlæg CSV-kolonner → Shopify-felter ({analyzeResult.rowCount} rækker)
          </div>
          <div className="space-y-2">
            {analyzeResult.headers.map((header) => (
              <div key={header} className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <span className="w-40 shrink-0 text-sm font-medium text-slate-700 truncate" title={header}>{header}</span>
                <span className="text-slate-400 text-xs">→</span>
                <select
                  className="ep-input h-8 flex-1 py-0 text-sm"
                  value={columnMap[header] ?? 'ignore'}
                  onChange={(e) => setColumnMap((prev) => ({ ...prev, [header]: e.target.value }))}
                >
                  {SHOPIFY_FIELD_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                {analyzeResult.previewRows[0]?.[header] && (
                  <span className="ml-1 max-w-[120px] truncate text-xs text-slate-400" title={analyzeResult.previewRows[0][header]}>
                    {analyzeResult.previewRows[0][header]}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            className="ep-btn-primary"
            onClick={() => setStep('preview')}
            disabled={!Object.values(columnMap).some((v) => v === 'title')}
          >
            Fortsæt til forhåndsvisning →
          </button>
          <button className="ep-btn-secondary" onClick={reset}>Annuller</button>
          {!Object.values(columnMap).some((v) => v === 'title') && (
            <span className="text-xs text-red-500">Mindst én kolonne skal kortlægges til &apos;Produkttitel&apos;</span>
          )}
        </div>
      </div>
    );
  }

  if (step === 'analyzing') {
    return (
      <div className="space-y-4">
        <div className="ep-card-strong p-4 md:p-5">
          <h1 className="ep-title">Importer produkter</h1>
        </div>
        <div className="ep-card p-8 flex flex-col items-center gap-4">
          <div className="h-10 w-10 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
          <p className="text-sm font-medium text-slate-700">AI analyserer din CSV…</p>
          <p className="text-xs text-slate-400">Finder og kortlægger kolonner automatisk</p>
        </div>
      </div>
    );
  }

  // step === 'idle'
  return (
    <div className="space-y-4">
      <div className="ep-card-strong p-4 md:p-5">
        <h1 className="ep-title">Importer produkter</h1>
        <p className="ep-subtitle mt-1">Upload en CSV med produktdata — AI kortlægger kolonnerne automatisk.</p>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => fileRef.current?.click()}
        className={`ep-card cursor-pointer rounded-2xl border-2 border-dashed p-10 text-center transition ${
          dragging ? 'border-indigo-400 bg-indigo-50' : csv ? 'border-emerald-400 bg-emerald-50' : 'border-slate-300 hover:border-indigo-300 hover:bg-slate-50'
        }`}
      >
        <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onFileChange} />
        {csv ? (
          <>
            <div className="text-2xl mb-2">&#10003;</div>
            <div className="text-sm font-medium text-emerald-700">{fileName}</div>
            <div className="mt-1 text-xs text-slate-400">Klik for at vælge en anden fil</div>
          </>
        ) : (
          <>
            <div className="mb-3 text-3xl">&#128203;</div>
            <div className="text-sm text-slate-500">Træk og slip din CSV her, eller <span className="text-indigo-600 underline">vælg fil</span></div>
          </>
        )}
        <div className="mt-1 text-xs text-slate-400">CSV, komma- eller semikolonsepareret</div>
      </div>

      {analyzeError && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {analyzeError}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          className="ep-btn-primary"
          disabled={!csv.trim()}
          onClick={() => void analyzeFile()}
        >
          Analyser CSV med AI →
        </button>
      </div>
    </div>
  );
}
