'use client';

import { useEffect, useState, useCallback } from 'react';
import { apiFetch } from '../../lib/api';

const FEED_BASE_URL = process.env.NEXT_PUBLIC_FEED_URL ?? 'https://feeds.epim.dk';

type FeedMapping = { fieldName: string; source: string };

type Feed = {
  id: string;
  name: string;
  format: string;
  feedType: string;
  urlKey: string;
  urlSecret: string;
  isActive: boolean;
  mappingsJson: FeedMapping[];
  createdAt: string;
};

const SHOPIFY_SOURCES: Array<{ value: string; label: string }> = [
  { value: 'title', label: 'Titel' },
  { value: 'handle', label: 'Handle / URL-slug' },
  { value: 'vendor', label: 'Leverandør' },
  { value: 'product_type', label: 'Produkttype' },
  { value: 'description', label: 'Beskrivelse (renset tekst)' },
  { value: 'description_html', label: 'Beskrivelse (HTML)' },
  { value: 'tags', label: 'Tags (kommasepareret)' },
  { value: 'id', label: 'Shopify-ID' },
  { value: 'url', label: 'Produkt-URL' },
  { value: 'availability', label: 'Tilgængelighed (in stock / out of stock)' },
  { value: 'images.0.url', label: 'Billede 1 URL' },
  { value: 'images.1.url', label: 'Billede 2 URL' },
  { value: 'images.2.url', label: 'Billede 3 URL' },
  { value: 'variants.0.price', label: 'Pris (variant 1)' },
  { value: 'variants.0.compare_at_price', label: 'Sammenlign-pris (variant 1)' },
  { value: 'variants.0.sku', label: 'SKU (variant 1)' },
  { value: 'variants.0.barcode', label: 'Stregkode / EAN (variant 1)' },
  { value: 'variants.0.inventory_quantity', label: 'Lagerantal (variant 1)' },
  { value: 'variants.0.weight', label: 'Vægt (variant 1)' },
];

const GOOGLE_STANDARD_FIELD_NAMES = new Set([
  'g:id', 'g:title', 'g:description', 'g:link', 'g:image_link', 'g:price',
  'g:availability', 'g:brand', 'g:gtin', 'g:mpn', 'g:product_type', 'g:condition',
]);

const GOOGLE_SHOPPING_DEFAULTS: FeedMapping[] = [
  { fieldName: 'g:id', source: 'id' },
  { fieldName: 'g:title', source: 'title' },
  { fieldName: 'g:description', source: 'description' },
  { fieldName: 'g:link', source: 'url' },
  { fieldName: 'g:image_link', source: 'images.0.url' },
  { fieldName: 'g:price', source: 'variants.0.price' },
  { fieldName: 'g:availability', source: 'availability' },
  { fieldName: 'g:brand', source: 'vendor' },
  { fieldName: 'g:gtin', source: 'variants.0.barcode' },
  { fieldName: 'g:mpn', source: 'variants.0.sku' },
  { fieldName: 'g:product_type', source: 'product_type' },
  { fieldName: 'g:condition', source: 'static:new' },
];

function SourceSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const isStatic = value.startsWith('static:');
  const staticVal = isStatic ? value.slice(7) : '';

  return (
    <div className="flex items-center gap-1.5 flex-1 min-w-0">
      <select
        value={isStatic ? '__static__' : value}
        onChange={(e) => {
          if (e.target.value === '__static__') onChange('static:');
          else onChange(e.target.value);
        }}
        className="flex-1 min-w-0 rounded-md border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-400"
      >
        <option value="">— Vælg kilde —</option>
        {SHOPIFY_SOURCES.map((s) => (
          <option key={s.value} value={s.value}>{s.label}</option>
        ))}
        <option value="__static__">Statisk værdi…</option>
      </select>
      {isStatic && (
        <input
          type="text"
          placeholder="fast værdi"
          value={staticVal}
          onChange={(e) => onChange(`static:${e.target.value}`)}
          className="w-28 rounded-md border border-gray-200 bg-white px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-400"
        />
      )}
    </div>
  );
}

function MappingEditor({
  mappings,
  onChange,
  isGoogle,
}: {
  mappings: FeedMapping[];
  onChange: (m: FeedMapping[]) => void;
  isGoogle: boolean;
}) {
  const updateRow = (i: number, field: keyof FeedMapping, val: string) => {
    const next = mappings.map((m, idx) => idx === i ? { ...m, [field]: val } : m);
    onChange(next);
  };
  const removeRow = (i: number) => onChange(mappings.filter((_, idx) => idx !== i));
  const addRow = () => onChange([...mappings, { fieldName: isGoogle ? 'g:' : '', source: '' }]);

  return (
    <div>
      <div className="rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="px-3 py-2 text-left font-medium text-gray-500 w-44">Feed-felt</th>
              <th className="px-3 py-2 text-left font-medium text-gray-500">Shopify-kilde</th>
              <th className="px-3 py-2 w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {mappings.map((m, i) => {
              const isStandardField = isGoogle && GOOGLE_STANDARD_FIELD_NAMES.has(m.fieldName);
              return (
                <tr key={i} className="hover:bg-gray-50">
                  <td className="px-3 py-1.5">
                    {isStandardField ? (
                      <span className="font-mono text-indigo-700">{m.fieldName}</span>
                    ) : (
                      <input
                        type="text"
                        value={m.fieldName}
                        onChange={(e) => updateRow(i, 'fieldName', e.target.value)}
                        placeholder={isGoogle ? 'g:custom_label_0' : 'feltNavn'}
                        className="w-full rounded border border-gray-200 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-400"
                      />
                    )}
                  </td>
                  <td className="px-3 py-1.5">
                    <SourceSelect value={m.source} onChange={(v) => updateRow(i, 'source', v)} />
                  </td>
                  <td className="px-2 py-1.5">
                    <button
                      onClick={() => removeRow(i)}
                      className="text-gray-300 hover:text-red-500 transition"
                      title="Fjern række"
                    >
                      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                      </svg>
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <button
        onClick={addRow}
        className="mt-2 flex items-center gap-1.5 text-xs text-indigo-600 hover:text-indigo-800 font-medium"
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        Tilføj felt
      </button>
    </div>
  );
}

export default function FeedsPage() {
  const [feeds, setFeeds] = useState<Feed[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  // Editor state
  const [name, setName] = useState('');
  const [feedType, setFeedType] = useState<'google_shopping' | 'custom'>('google_shopping');
  const [format, setFormat] = useState<'xml' | 'csv'>('xml');
  const [mappings, setMappings] = useState<FeedMapping[]>(GOOGLE_SHOPPING_DEFAULTS);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch<{ feeds: Feed[] }>('/feeds');
      setFeeds(res.feeds);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openNew = () => {
    setName('');
    setFeedType('google_shopping');
    setFormat('xml');
    setMappings(GOOGLE_SHOPPING_DEFAULTS);
    setEditingId('new');
  };

  const openEdit = (feed: Feed) => {
    setName(feed.name);
    setFeedType(feed.feedType as 'google_shopping' | 'custom');
    setFormat(feed.format as 'xml' | 'csv');
    setMappings(Array.isArray(feed.mappingsJson) ? feed.mappingsJson : []);
    setEditingId(feed.id);
  };

  const onFeedTypeChange = (t: 'google_shopping' | 'custom') => {
    setFeedType(t);
    if (t === 'google_shopping') {
      setFormat('xml');
      setMappings(GOOGLE_SHOPPING_DEFAULTS);
    } else {
      setMappings([]);
    }
  };

  const save = async () => {
    if (!name.trim()) { setMessage('Giv feed et navn.'); return; }
    setSaving(true);
    setMessage('');
    try {
      if (editingId === 'new') {
        const res = await apiFetch<{ feed: Feed }>('/feeds', {
          method: 'POST',
          body: JSON.stringify({ name: name.trim(), feedType, format, mappingsJson: mappings }),
        });
        setFeeds((prev) => [...prev, res.feed]);
      } else {
        const res = await apiFetch<{ feed: Feed }>(`/feeds/${editingId}`, {
          method: 'PUT',
          body: JSON.stringify({ name: name.trim(), feedType, format, mappingsJson: mappings }),
        });
        setFeeds((prev) => prev.map((f) => f.id === editingId ? res.feed : f));
      }
      setEditingId(null);
      setMessage('Gemt.');
    } catch {
      setMessage('Kunne ikke gemme. Prøv igen.');
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (feed: Feed) => {
    try {
      const res = await apiFetch<{ feed: Feed }>(`/feeds/${feed.id}`, {
        method: 'PUT',
        body: JSON.stringify({ isActive: !feed.isActive }),
      });
      setFeeds((prev) => prev.map((f) => f.id === feed.id ? res.feed : f));
    } catch { setMessage('Kunne ikke opdatere status.'); }
  };

  const deleteFeed = async (id: string) => {
    if (!confirm('Slet dette feed?')) return;
    try {
      await apiFetch(`/feeds/${id}`, { method: 'DELETE' });
      setFeeds((prev) => prev.filter((f) => f.id !== id));
      if (editingId === id) setEditingId(null);
    } catch { setMessage('Kunne ikke slette feed.'); }
  };

  const feedUrl = (feed: Feed) => `${FEED_BASE_URL}/feed/${feed.urlKey}/${feed.urlSecret}`;

  const copyUrl = (feed: Feed) => {
    void navigator.clipboard.writeText(feedUrl(feed));
    setCopied(feed.urlKey);
    setTimeout(() => setCopied(null), 2000);
  };

  const isGoogle = feedType === 'google_shopping';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="ep-title">Feeds</h1>
          <p className="mt-0.5 text-sm text-gray-500">Publiser produkt-feeds direkte fra Shopify-data til Google Shopping og andre kanaler.</p>
        </div>
        <button
          onClick={openNew}
          className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 transition"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          Nyt feed
        </button>
      </div>

      {message && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-700">{message}</div>
      )}

      {/* Feed editor */}
      {editingId !== null && (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-5 space-y-4">
          <h2 className="text-sm font-semibold text-gray-800">
            {editingId === 'new' ? 'Nyt feed' : 'Rediger feed'}
          </h2>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Navn</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="fx Google Shopping feed"
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Skabelon</label>
              <select
                value={feedType}
                onChange={(e) => onFeedTypeChange(e.target.value as 'google_shopping' | 'custom')}
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
              >
                <option value="google_shopping">Google Shopping</option>
                <option value="custom">Brugerdefineret</option>
              </select>
            </div>
            {!isGoogle && (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Format</label>
                <select
                  value={format}
                  onChange={(e) => setFormat(e.target.value as 'xml' | 'csv')}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                >
                  <option value="xml">XML</option>
                  <option value="csv">CSV</option>
                </select>
              </div>
            )}
          </div>

          {isGoogle && (
            <div className="flex items-start gap-2 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2.5">
              <svg viewBox="0 0 24 24" className="h-4 w-4 flex-shrink-0 text-blue-500 mt-0.5" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <p className="text-xs text-blue-700">
                Google Shopping bruger RSS 2.0 XML med <code className="font-mono">g:</code>-namespace. Standardfelterne (g:id, g:title osv.) har låste feltnavne — skift kilden eller tilføj ekstra felter som fx <code className="font-mono">g:color</code> eller <code className="font-mono">g:custom_label_0</code>.
              </p>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-2">Feltmapping</label>
            <MappingEditor mappings={mappings} onChange={setMappings} isGoogle={isGoogle} />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={save}
              disabled={saving}
              className="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60 transition"
            >
              {saving ? 'Gemmer…' : 'Gem feed'}
            </button>
            <button
              onClick={() => setEditingId(null)}
              className="rounded-lg border border-gray-200 bg-white px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-50 transition"
            >
              Annuller
            </button>
          </div>
        </div>
      )}

      {/* Feed list */}
      {loading ? (
        <div className="py-12 text-center text-sm text-gray-400">Henter feeds…</div>
      ) : feeds.length === 0 && editingId === null ? (
        <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 py-14 text-center">
          <svg viewBox="0 0 24 24" className="mx-auto h-8 w-8 text-gray-300 mb-3" fill="none" stroke="currentColor" strokeWidth="1.5">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
          </svg>
          <p className="text-sm font-medium text-gray-500">Ingen feeds endnu</p>
          <p className="mt-1 text-xs text-gray-400">Klik "Nyt feed" for at oprette dit første feed.</p>
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-xs font-medium text-gray-500">
                <th className="px-4 py-2.5 text-left">Navn</th>
                <th className="px-4 py-2.5 text-left">Type</th>
                <th className="px-4 py-2.5 text-left">Format</th>
                <th className="px-4 py-2.5 text-left">Feed-URL</th>
                <th className="px-4 py-2.5 text-left">Aktiv</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {feeds.map((feed) => (
                <tr key={feed.id} className="hover:bg-gray-50 transition">
                  <td className="px-4 py-3 font-medium text-gray-800">{feed.name}</td>
                  <td className="px-4 py-3 text-gray-600">
                    {feed.feedType === 'google_shopping' ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                        Google Shopping
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">
                        Brugerdefineret
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-500 uppercase text-xs font-medium">{feed.format}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <code className="truncate max-w-[220px] text-[11px] text-gray-500 font-mono">{feedUrl(feed)}</code>
                      <button
                        onClick={() => copyUrl(feed)}
                        className="flex-shrink-0 text-gray-400 hover:text-indigo-600 transition"
                        title="Kopiér URL"
                      >
                        {copied === feed.urlKey ? (
                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-emerald-500" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <polyline points="20 6 9 17 4 12"/>
                          </svg>
                        ) : (
                          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                            <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                          </svg>
                        )}
                      </button>
                      <a
                        href={feedUrl(feed)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-shrink-0 text-gray-400 hover:text-indigo-600 transition"
                        title="Åbn feed"
                      >
                        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                          <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                        </svg>
                      </a>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => toggleActive(feed)}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${feed.isActive ? 'bg-emerald-500' : 'bg-gray-200'}`}
                    >
                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition ${feed.isActive ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3 justify-end">
                      <button
                        onClick={() => openEdit(feed)}
                        className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
                      >
                        Rediger
                      </button>
                      <button
                        onClick={() => deleteFeed(feed.id)}
                        className="text-xs text-red-500 hover:text-red-700"
                      >
                        Slet
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="rounded-xl border border-gray-100 bg-gray-50 p-4">
        <p className="text-xs text-gray-500 leading-relaxed">
          <strong className="text-gray-700">Om feeds:</strong> Datafeedet henter produkter direkte fra Shopify, ikke fra ePIM — det sikrer at det er de faktisk publicerede data der sendes ud. Google Shopping kræver et aktivt Merchant Center-konto, og feed-URL&apos;en indsættes som datafeed i Google Merchant Center.
        </p>
      </div>
    </div>
  );
}
