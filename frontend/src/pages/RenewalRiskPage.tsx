import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { RiskFlag, RiskTier } from '../types';
import { fetchLatestRisk, calculateRisk } from '../api';
import RiskTable from '../components/RiskTable';

type TierFilter = 'all' | RiskTier;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month:  'short',
    day:    'numeric',
    year:   'numeric',
    hour:   '2-digit',
    minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// Tier filter buttons
// ---------------------------------------------------------------------------

function FilterBar({
  flags,
  active,
  onChange,
}: {
  flags:    RiskFlag[];
  active:   TierFilter;
  onChange: (t: TierFilter) => void;
}) {
  const counts = {
    all:    flags.length,
    high:   flags.filter((f) => f.riskTier === 'high').length,
    medium: flags.filter((f) => f.riskTier === 'medium').length,
    low:    flags.filter((f) => f.riskTier === 'low').length,
  };

  const tabs: { id: TierFilter; label: string; color: string }[] = [
    { id: 'all',    label: 'All',    color: 'bg-gray-100 text-gray-700' },
    { id: 'high',   label: 'High',   color: 'bg-red-100 text-red-700' },
    { id: 'medium', label: 'Medium', color: 'bg-amber-100 text-amber-700' },
    { id: 'low',    label: 'Low',    color: 'bg-green-100 text-green-700' },
  ];

  return (
    <div className="flex gap-2 flex-wrap">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`px-3 py-1 rounded-full text-xs font-medium transition-all
            ${active === tab.id
              ? `${tab.color} ring-2 ring-offset-1 ring-current`
              : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
            }`}
        >
          {tab.label}
          <span className="ml-1.5 opacity-70">{counts[tab.id]}</span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function RenewalRiskPage() {
  const { propertyId } = useParams<{ propertyId: string }>();
  const navigate       = useNavigate();

  // ── Data state ──────────────────────────────────────────────────────────
  type PageState =
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'ready'; flags: RiskFlag[]; calculatedAt: string | null };

  const [pageState, setPageState] = useState<PageState>({ status: 'loading' });

  // ── Calculate form state ──────────────────────────────────────────────
  const [asOfDate,     setAsOfDate]     = useState(today());
  const [calculating,  setCalculating]  = useState(false);
  const [calcError,    setCalcError]    = useState('');

  // ── Filter state ───────────────────────────────────────────────────────
  const [tierFilter, setTierFilter] = useState<TierFilter>('all');

  // ── Load data ──────────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    if (!propertyId) return;
    setPageState({ status: 'loading' });
    try {
      const data = await fetchLatestRisk(propertyId);
      setPageState({ status: 'ready', flags: data.flags, calculatedAt: data.calculatedAt });
    } catch (err) {
      setPageState({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to load data',
      });
    }
  }, [propertyId]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Calculate ──────────────────────────────────────────────────────────
  async function handleCalculate(e: React.FormEvent) {
    e.preventDefault();
    if (!propertyId || calculating) return;
    setCalculating(true);
    setCalcError('');
    try {
      await calculateRisk(propertyId, asOfDate);
      await loadData();
    } catch (err) {
      setCalcError(err instanceof Error ? err.message : 'Calculation failed');
    } finally {
      setCalculating(false);
    }
  }

  // ── Derived data ───────────────────────────────────────────────────────
  const flags = pageState.status === 'ready' ? pageState.flags : [];
  const visibleFlags = tierFilter === 'all'
    ? flags
    : flags.filter((f) => f.riskTier === tierFilter);

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-4">
          <div>
            <button
              onClick={() => navigate('/')}
              className="text-xs text-gray-400 hover:text-gray-600 mb-1 block"
            >
              ← Back
            </button>
            <h1 className="text-lg font-semibold text-gray-900">Renewal Risk Dashboard</h1>
            <p className="text-xs text-gray-400 font-mono mt-0.5">{propertyId}</p>
          </div>

          {/* Calculate form */}
          <form onSubmit={handleCalculate} className="flex items-end gap-2">
            <div>
              <label className="block text-xs text-gray-500 mb-1">As of date</label>
              <input
                type="date"
                value={asOfDate}
                onChange={(e) => setAsOfDate(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm
                           focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <button
              type="submit"
              disabled={calculating}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white
                         font-medium rounded-lg px-4 py-1.5 text-sm transition-colors
                         whitespace-nowrap"
            >
              {calculating ? 'Calculating…' : 'Calculate Scores'}
            </button>
          </form>
        </div>

        {calcError && (
          <div className="max-w-6xl mx-auto mt-2">
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-1.5">
              {calcError}
            </p>
          </div>
        )}
      </header>

      {/* Main content */}
      <main className="max-w-6xl mx-auto px-6 py-6">

        {/* Loading */}
        {pageState.status === 'loading' && (
          <div className="flex justify-center items-center py-20">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <span className="ml-3 text-sm text-gray-500">Loading…</span>
          </div>
        )}

        {/* Error */}
        {pageState.status === 'error' && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-center">
            <p className="text-red-700 font-medium mb-1">Failed to load risk data</p>
            <p className="text-red-500 text-sm mb-4">{pageState.message}</p>
            <button
              onClick={loadData}
              className="text-sm text-red-700 underline"
            >
              Try again
            </button>
          </div>
        )}

        {/* Ready */}
        {pageState.status === 'ready' && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200">
            {/* Card header */}
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between gap-4 flex-wrap">
              <div>
                <h2 className="text-sm font-semibold text-gray-800">At-Risk Residents</h2>
                {pageState.calculatedAt ? (
                  <p className="text-xs text-gray-400 mt-0.5">
                    Last calculated: {formatDate(pageState.calculatedAt)}
                  </p>
                ) : (
                  <p className="text-xs text-amber-600 mt-0.5">
                    No scores yet — run "Calculate Scores" above.
                  </p>
                )}
              </div>
              <FilterBar flags={flags} active={tierFilter} onChange={setTierFilter} />
            </div>

            {/* Table */}
            <div className="px-6 py-4">
              <RiskTable flags={visibleFlags} propertyId={propertyId!} />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
