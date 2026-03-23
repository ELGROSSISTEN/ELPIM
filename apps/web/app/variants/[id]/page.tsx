'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { API_URL, apiFetch, getActiveShopId, getToken } from '../../../lib/api';
import { registerBackgroundActivityJobs } from '../../../lib/background-activity';
import { toast } from '../../../components/toaster';

type FieldDefinition = {
  id: string;
  key: string;
  label: string;
  scope: 'product' | 'variant' | 'collection';
  type: 'text' | 'number' | 'boolean' | 'json' | 'date' | 'html';
  lockLevel?: 'none' | 'users' | 'all';
};

type Variant = {
  id: string;
  sku?: string | null;
  barcode?: string | null;
  price?: string | null;
  compareAtPrice?: string | null;
  optionValuesJson?: string[];
  weight?: number | null;
  weightUnit?: string | null;
  requiresShipping?: boolean | null;
  taxable?: boolean | null;
  inventoryPolicy?: string | null;
  inventoryQuantity?: number | null;
  hsCode?: string | null;
  countryOfOrigin?: string | null;
  updatedAt: string;
  lastShopifySyncAt?: string | null;
  product: {
    id: string;
    title: string;
    handle: string;
    vendor?: string | null;
    productType?: string | null;
    descriptionHtml?: string | null;
  };
  fieldValues?: Array<{
    fieldDefinitionId: string;
    valueJson: unknown;
  }>;
};

type CoreState = {
  sku: string;
  barcode: string;
  price: string;
  compareAtPrice: string;
  optionValues: string;
};

type StamdataState = {
  weight: string;
  weightUnit: string;
  requiresShipping: boolean;
  taxable: boolean;
  inventoryPolicy: string;
  hsCode: string;
  countryOfOrigin: string;
};

const WEIGHT_UNITS = [
  { value: 'KILOGRAMS', label: 'kg' },
  { value: 'GRAMS', label: 'g' },
  { value: 'POUNDS', label: 'lb' },
  { value: 'OUNCES', label: 'oz' },
];

const INVENTORY_POLICIES = [
  { value: 'DENY', label: 'Stop salg ved udsolgt' },
  { value: 'CONTINUE', label: 'Fortsæt salg ved udsolgt' },
];

const defaultCore: CoreState = { sku: '', barcode: '', price: '', compareAtPrice: '', optionValues: '' };
const defaultStamdata: StamdataState = { weight: '', weightUnit: 'KILOGRAMS', requiresShipping: true, taxable: true, inventoryPolicy: 'DENY', hsCode: '', countryOfOrigin: '' };

export default function VariantDetailsPage() {
  const { id } = useParams<{ id: string }>();
  const [variant, setVariant] = useState<Variant | null>(null);
  const [aiSuggestLoading, setAiSuggestLoading] = useState<Record<string, boolean>>({});
  const [fields, setFields] = useState<FieldDefinition[]>([]);
  const [message, setMessage] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [draftSaveStatus, setDraftSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [userPlatformRole, setUserPlatformRole] = useState<string>('none');
  const [userRole, setUserRole] = useState<string>('member');
  const [lockPopoverId, setLockPopoverId] = useState<string | null>(null);

  useEffect(() => {
    if (!lockPopoverId) return;
    const handler = () => setLockPopoverId(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [lockPopoverId]);

  const [core, setCore] = useState<CoreState>(defaultCore);
  const initialCoreRef = useRef<CoreState>(defaultCore);
  const [stamdata, setStamdata] = useState<StamdataState>(defaultStamdata);
  const initialStamdataRef = useRef<StamdataState>(defaultStamdata);
  const [fieldEdits, setFieldEdits] = useState<Record<string, string>>({});
  const initialFieldEditsRef = useRef<Record<string, string>>({});

  useEffect(() => {
    Promise.all([
      apiFetch<{ variant: Variant }>(`/variants/${id}`),
      apiFetch<{ fields: FieldDefinition[] }>('/fields'),
      apiFetch<{ drafts: Array<{ patchJson: Record<string, unknown> }> }>(`/drafts?entityType=variant&entityId=${id}`),
      apiFetch<{ user: { platformRole?: string; role?: string } | null }>('/me'),
    ])
      .then(([variantResponse, fieldsResponse, draftResponse, meResponse]) => {
        const variantData = variantResponse.variant;
        const variantFields = fieldsResponse.fields.filter((field) => field.scope === 'variant');
        setVariant(variantData);
        document.title = `${variantData.sku ?? 'Variant'} | ePIM`;
        setFields(variantFields);

        const patch = draftResponse.drafts[0]?.patchJson ?? {};

        const baseCore: CoreState = {
          sku: variantData.sku ?? '',
          barcode: variantData.barcode ?? '',
          price: variantData.price ?? '',
          compareAtPrice: variantData.compareAtPrice ?? '',
          optionValues: (variantData.optionValuesJson ?? []).join(', '),
        };
        const hydratedCore: CoreState = {
          sku: String(patch.sku ?? baseCore.sku),
          barcode: String(patch.barcode ?? baseCore.barcode),
          price: String(patch.price ?? baseCore.price),
          compareAtPrice: String(patch.compareAtPrice ?? baseCore.compareAtPrice),
          optionValues: String(patch.optionValues ?? baseCore.optionValues),
        };
        setCore(hydratedCore);
        initialCoreRef.current = { ...hydratedCore };

        const baseStamdata: StamdataState = {
          weight: variantData.weight != null ? String(variantData.weight) : '',
          weightUnit: variantData.weightUnit ?? 'KILOGRAMS',
          requiresShipping: variantData.requiresShipping ?? true,
          taxable: variantData.taxable ?? true,
          inventoryPolicy: variantData.inventoryPolicy ?? 'DENY',
          hsCode: variantData.hsCode ?? '',
          countryOfOrigin: variantData.countryOfOrigin ?? '',
        };
        const hydratedStamdata: StamdataState = {
          weight: patch.weight != null ? String(patch.weight) : baseStamdata.weight,
          weightUnit: typeof patch.weightUnit === 'string' ? patch.weightUnit : baseStamdata.weightUnit,
          requiresShipping: patch.requiresShipping != null ? Boolean(patch.requiresShipping) : baseStamdata.requiresShipping,
          taxable: patch.taxable != null ? Boolean(patch.taxable) : baseStamdata.taxable,
          inventoryPolicy: typeof patch.inventoryPolicy === 'string' ? patch.inventoryPolicy : baseStamdata.inventoryPolicy,
          hsCode: typeof patch.hsCode === 'string' ? patch.hsCode : baseStamdata.hsCode,
          countryOfOrigin: typeof patch.countryOfOrigin === 'string' ? patch.countryOfOrigin : baseStamdata.countryOfOrigin,
        };
        setStamdata(hydratedStamdata);
        initialStamdataRef.current = { ...hydratedStamdata };

        const values: Record<string, string> = {};
        for (const field of variantFields) {
          const committed = variantData.fieldValues?.find((item) => item.fieldDefinitionId === field.id)?.valueJson;
          const fromDraft = patch[field.id] ?? patch[field.key as string];
          values[field.id] = fromDraft != null ? String(fromDraft) : (committed == null ? '' : String(committed));
        }
        setFieldEdits(values);
        initialFieldEditsRef.current = { ...values };
        setDraftSaveStatus('idle');
        setUserPlatformRole(meResponse.user?.platformRole ?? 'none');
        setUserRole(meResponse.user?.role ?? 'member');
      })
      .catch(() => {
        setVariant(null);
        setMessage('Kunne ikke indlæse variant.');
      });
  }, [id]);

  const hasChanges = useMemo(() => {
    if (!variant) return false;
    const ic = initialCoreRef.current;
    const is = initialStamdataRef.current;
    if (core.sku !== ic.sku) return true;
    if (core.barcode !== ic.barcode) return true;
    if (core.price !== ic.price) return true;
    if (core.compareAtPrice !== ic.compareAtPrice) return true;
    if (core.optionValues !== ic.optionValues) return true;
    if (stamdata.weight !== is.weight) return true;
    if (stamdata.weightUnit !== is.weightUnit) return true;
    if (stamdata.requiresShipping !== is.requiresShipping) return true;
    if (stamdata.taxable !== is.taxable) return true;
    if (stamdata.inventoryPolicy !== is.inventoryPolicy) return true;
    if (stamdata.hsCode !== is.hsCode) return true;
    if (stamdata.countryOfOrigin !== is.countryOfOrigin) return true;
    for (const field of fields) {
      if ((fieldEdits[field.id] ?? '') !== (initialFieldEditsRef.current[field.id] ?? '')) return true;
    }
    return false;
  }, [variant, fields, core, stamdata, fieldEdits]);

  // Flush draft to server on page unload (keepalive guarantees delivery)
  useEffect(() => {
    if (!hasChanges) return;
    const handler = () => {
      if (draftSaveStatus === 'saved' || draftSaveStatus === 'saving') return;
      if (variant) {
        const patchJson: Record<string, unknown> = {
          sku: core.sku,
          barcode: core.barcode,
          price: core.price,
          compareAtPrice: core.compareAtPrice,
          optionValues: core.optionValues,
          weight: stamdata.weight,
          weightUnit: stamdata.weightUnit,
          requiresShipping: stamdata.requiresShipping,
          taxable: stamdata.taxable,
          inventoryPolicy: stamdata.inventoryPolicy,
          hsCode: stamdata.hsCode,
          countryOfOrigin: stamdata.countryOfOrigin,
        };
        for (const field of fields) {
          patchJson[field.id] = fieldEdits[field.id] ?? '';
        }
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
          body: JSON.stringify({ entityType: 'variant', entityId: variant.id, patchJson }),
        });
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasChanges, draftSaveStatus, variant, core, stamdata, fields, fieldEdits]);

  const save = useCallback(async (syncNow: boolean): Promise<void> => {
    if (!variant) return;
    setIsSaving(true);
    setMessage('');
    try {
      const weightNum = stamdata.weight !== '' ? parseFloat(stamdata.weight) : undefined;
      const response = await apiFetch<{ variant: Variant; syncJobId?: string | null }>(`/variants/${variant.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          sku: core.sku,
          barcode: core.barcode,
          price: core.price,
          compareAtPrice: core.compareAtPrice,
          optionValuesJson: core.optionValues
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
          weight: weightNum,
          weightUnit: stamdata.weightUnit,
          requiresShipping: stamdata.requiresShipping,
          taxable: stamdata.taxable,
          inventoryPolicy: stamdata.inventoryPolicy,
          hsCode: stamdata.hsCode,
          countryOfOrigin: stamdata.countryOfOrigin,
          fieldValues: fields.map((field) => ({
            fieldDefinitionId: field.id,
            valueJson: fieldEdits[field.id] ?? '',
          })),
          syncNow,
        }),
      });
      if (response.syncJobId) {
        registerBackgroundActivityJobs([response.syncJobId]);
      }

      const refreshed = await apiFetch<{ variant: Variant }>(`/variants/${variant.id}`);
      setVariant(refreshed.variant);
      initialCoreRef.current = { ...core };
      initialStamdataRef.current = { ...stamdata };
      initialFieldEditsRef.current = { ...fieldEdits };
      setDraftSaveStatus('idle');
      apiFetch(`/drafts/variant/${variant.id}`, { method: 'DELETE' }).catch(() => {});
      toast.success(syncNow ? 'Variant gemt og sendt til Shopify-sync.' : 'Variant gemt.');
    } catch {
      toast.error(syncNow ? 'Kunne ikke gemme/synkronisere variant.' : 'Kunne ikke gemme variant.');
    } finally {
      setIsSaving(false);
    }
  }, [variant, core, stamdata, fields, fieldEdits]);

  // Cmd+S / Ctrl+S → gem
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (hasChanges && !isSaving) void save(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [hasChanges, isSaving, save]);

  // Auto-save draft: debounce 2 seconds after edits change
  useEffect(() => {
    if (!variant || !hasChanges) return;
    setDraftSaveStatus('idle');
    const patchJson: Record<string, unknown> = {
      sku: core.sku,
      barcode: core.barcode,
      price: core.price,
      compareAtPrice: core.compareAtPrice,
      optionValues: core.optionValues,
      weight: stamdata.weight,
      weightUnit: stamdata.weightUnit,
      requiresShipping: stamdata.requiresShipping,
      taxable: stamdata.taxable,
      inventoryPolicy: stamdata.inventoryPolicy,
    };
    for (const field of fields) {
      patchJson[field.id] = fieldEdits[field.id] ?? '';
    }
    const timeoutId = setTimeout(() => {
      setDraftSaveStatus('saving');
      apiFetch('/drafts', {
        method: 'PUT',
        body: JSON.stringify({ entityType: 'variant', entityId: variant.id, patchJson }),
      })
        .then(() => setDraftSaveStatus('saved'))
        .catch(() => setDraftSaveStatus('idle'));
    }, 2000);
    return () => clearTimeout(timeoutId);
  }, [variant, core, stamdata, fieldEdits, fields, hasChanges]);

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
          <button type="button" onClick={() => setLockPopoverId(lockPopoverId === fieldId ? null : fieldId)} className="text-slate-400 hover:text-slate-600 transition" title="Lås-indstillinger">
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

  if (!variant) {
    if (message) return <div className="ep-card p-4 md:p-5 text-sm text-red-600">{message}</div>;
    return (
      <div className="space-y-4 animate-pulse">
        <div className="ep-card-strong h-24 p-5" />
        <div className="ep-card h-52 p-5" />
        <div className="ep-card h-24 p-5" />
      </div>
    );
  }

  return (
    <div className={`space-y-4 ${hasChanges ? 'pb-20' : ''}`}>
      <div className="ep-card-strong p-4 md:p-5">
        <div className="mb-1 text-xs uppercase tracking-wide text-indigo-100/80">Variant</div>
        <h1 className="ep-title">{core.sku || variant.sku || 'Uden SKU'}</h1>
        <p className="ep-subtitle mt-1">
          Produkt: <Link href={`/products/${variant.product.id}`} className="text-indigo-700 underline">{variant.product.title}</Link>
        </p>
      </div>

      {/* Core fields */}
      <div className="ep-card p-4 md:p-5 space-y-3">
        <h2 className="text-base font-semibold text-slate-900">Grunddata</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="text-sm">
            <span className="font-medium text-slate-700">SKU</span>
            <input className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2" value={core.sku} onChange={(e) => setCore((p) => ({ ...p, sku: e.target.value }))} />
          </label>
          <label className="text-sm">
            <span className="font-medium text-slate-700">Stregkode</span>
            <input className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2" value={core.barcode} onChange={(e) => setCore((p) => ({ ...p, barcode: e.target.value }))} />
          </label>
          <label className="text-sm">
            <span className="font-medium text-slate-700">Pris</span>
            <input className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2" value={core.price} onChange={(e) => setCore((p) => ({ ...p, price: e.target.value }))} />
          </label>
          <label className="text-sm">
            <span className="font-medium text-slate-700">Sammenligningspris</span>
            <input className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2" value={core.compareAtPrice} onChange={(e) => setCore((p) => ({ ...p, compareAtPrice: e.target.value }))} />
          </label>
          <label className="text-sm md:col-span-2">
            <span className="font-medium text-slate-700">Variantoptioner (kommasepareret)</span>
            <input className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2" value={core.optionValues} onChange={(e) => setCore((p) => ({ ...p, optionValues: e.target.value }))} />
          </label>
        </div>
      </div>

      {/* Stamdata */}
      <div className="ep-card p-4 md:p-5 space-y-3">
        <h2 className="text-base font-semibold text-slate-900">Stamdata</h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {/* Weight */}
          <div className="text-sm">
            <span className="font-medium text-slate-700">Vægt</span>
            <div className="mt-1 flex gap-2">
              <input
                type="number"
                min="0"
                step="any"
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
                value={stamdata.weight}
                onChange={(e) => setStamdata((p) => ({ ...p, weight: e.target.value }))}
                placeholder="0"
              />
              <select
                className="rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm"
                value={stamdata.weightUnit}
                onChange={(e) => setStamdata((p) => ({ ...p, weightUnit: e.target.value }))}
              >
                {WEIGHT_UNITS.map((u) => (
                  <option key={u.value} value={u.value}>{u.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Inventory policy */}
          <label className="text-sm">
            <span className="font-medium text-slate-700">Lagerpolitik</span>
            <select
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
              value={stamdata.inventoryPolicy}
              onChange={(e) => setStamdata((p) => ({ ...p, inventoryPolicy: e.target.value }))}
            >
              {INVENTORY_POLICIES.map((pol) => (
                <option key={pol.value} value={pol.value}>{pol.label}</option>
              ))}
            </select>
          </label>

          {/* Inventory quantity — read-only from Shopify */}
          <div className="text-sm">
            <span className="font-medium text-slate-700">Lagerantal</span>
            <div className="mt-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-600">
              {variant.inventoryQuantity != null ? variant.inventoryQuantity : <span className="text-slate-400 italic">Ikke tilgængeligt</span>}
              <span className="ml-2 text-xs text-slate-400">(skrivebeskyttet — administreres i Shopify)</span>
            </div>
          </div>

          {/* HS-kode */}
          <div className="text-sm">
            <span className="font-medium text-slate-700">HS-kode</span>
            <div className="mt-1 flex gap-1.5">
              <input
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
                value={stamdata.hsCode}
                onChange={(e) => setStamdata((p) => ({ ...p, hsCode: e.target.value }))}
                placeholder="Ikke angivet"
                maxLength={20}
              />
              <button
                type="button"
                title="Generer med AI"
                disabled={aiSuggestLoading['hsCode']}
                className="flex-shrink-0 rounded-lg border border-indigo-200 bg-indigo-50 px-2 py-1 text-indigo-600 hover:bg-indigo-100 disabled:opacity-50 transition"
                onClick={async () => {
                  setAiSuggestLoading((p) => ({ ...p, hsCode: true }));
                  try {
                    const res = await apiFetch<{ value: string }>(`/variants/${variant!.id}/ai-suggest`, { method: 'POST', body: JSON.stringify({ field: 'hsCode' }) });
                    if (res.value) setStamdata((p) => ({ ...p, hsCode: res.value }));
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : 'AI-generering fejlede.';
                    if (msg.includes('ikke fastslå') || msg.includes('ugyldig')) { toast.info(msg); } else { toast.error(msg); }
                  }
                  finally { setAiSuggestLoading((p) => ({ ...p, hsCode: false })); }
                }}
              >
                {aiSuggestLoading['hsCode']
                  ? <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                  : <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m12 3-1.5 4.5L6 9l4.5 1.5L12 15l1.5-4.5L18 9l-4.5-1.5Z"/><path d="M5 19h2M19 19h2M16 16l1.5 1.5M6.5 16 5 17.5"/></svg>
                }
              </button>
            </div>
          </div>

          {/* Oprindelsesland */}
          <div className="text-sm">
            <span className="font-medium text-slate-700">Oprindelsesland</span>
            <div className="mt-1 flex gap-1.5">
              <input
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 uppercase"
                value={stamdata.countryOfOrigin}
                onChange={(e) => setStamdata((p) => ({ ...p, countryOfOrigin: e.target.value.toUpperCase().slice(0, 2) }))}
                placeholder="Ikke angivet"
                maxLength={2}
              />
              <button
                type="button"
                title="Generer med AI"
                disabled={aiSuggestLoading['countryOfOrigin']}
                className="flex-shrink-0 rounded-lg border border-indigo-200 bg-indigo-50 px-2 py-1 text-indigo-600 hover:bg-indigo-100 disabled:opacity-50 transition"
                onClick={async () => {
                  setAiSuggestLoading((p) => ({ ...p, countryOfOrigin: true }));
                  try {
                    const res = await apiFetch<{ value: string }>(`/variants/${variant!.id}/ai-suggest`, { method: 'POST', body: JSON.stringify({ field: 'countryOfOrigin' }) });
                    if (res.value) setStamdata((p) => ({ ...p, countryOfOrigin: res.value.toUpperCase().slice(0, 2) }));
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : 'AI-generering fejlede.';
                    if (msg.includes('ikke fastslå') || msg.includes('ugyldig')) { toast.info(msg); } else { toast.error(msg); }
                  }
                  finally { setAiSuggestLoading((p) => ({ ...p, countryOfOrigin: false })); }
                }}
              >
                {aiSuggestLoading['countryOfOrigin']
                  ? <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                  : <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m12 3-1.5 4.5L6 9l4.5 1.5L12 15l1.5-4.5L18 9l-4.5-1.5Z"/><path d="M5 19h2M19 19h2M16 16l1.5 1.5M6.5 16 5 17.5"/></svg>
                }
              </button>
            </div>
          </div>

          {/* Toggles */}
          <div className="text-sm flex flex-col gap-3 md:col-span-1">
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <button
                type="button"
                role="switch"
                aria-checked={stamdata.requiresShipping}
                onClick={() => setStamdata((p) => ({ ...p, requiresShipping: !p.requiresShipping }))}
                className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none ${stamdata.requiresShipping ? 'bg-indigo-600' : 'bg-slate-300'}`}
              >
                <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${stamdata.requiresShipping ? 'translate-x-4' : 'translate-x-0'}`} />
              </button>
              <span className="font-medium text-slate-700">Kræver forsendelse</span>
            </label>
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <button
                type="button"
                role="switch"
                aria-checked={stamdata.taxable}
                onClick={() => setStamdata((p) => ({ ...p, taxable: !p.taxable }))}
                className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none ${stamdata.taxable ? 'bg-indigo-600' : 'bg-slate-300'}`}
              >
                <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${stamdata.taxable ? 'translate-x-4' : 'translate-x-0'}`} />
              </button>
              <span className="font-medium text-slate-700">Momspligtig</span>
            </label>
          </div>
        </div>
      </div>

      {/* Custom variant fields */}
      {fields.length > 0 && (
        <div className="ep-card p-4 md:p-5 space-y-3">
          <h2 className="text-base font-semibold text-slate-900">Ekstra felter</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {fields.map((field) => (
              <div key={field.id} className="text-sm">
                <label htmlFor={`field-${field.id}`} className="font-medium text-slate-700 flex items-center gap-1.5">
                  {field.label}
                  {renderLockIcon(field.id, field.lockLevel)}
                </label>
                <input
                  id={`field-${field.id}`}
                  className={`mt-1 w-full rounded-lg border px-3 py-2 ${isFieldLockedForMe(field.lockLevel) ? 'border-slate-200 bg-slate-50 cursor-not-allowed text-slate-400' : 'border-slate-300 bg-white'}`}
                  value={fieldEdits[field.id] ?? ''}
                  disabled={isFieldLockedForMe(field.lockLevel)}
                  onChange={(event) => setFieldEdits((prev) => ({ ...prev, [field.id]: event.target.value }))}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {message ? <div className="ep-card px-3 py-2 text-sm text-slate-700">{message}</div> : null}

      {/* Sticky save bar */}
      {hasChanges && (
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
                onClick={() => void save(false)}
                disabled={isSaving}
              >
                {isSaving ? 'Gemmer…' : 'Gem kladde'}
              </button>
              <button
                className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60 transition shadow-sm"
                onClick={() => void save(true)}
                disabled={isSaving}
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
