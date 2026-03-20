import { Fragment, useState } from 'react';
import type { RiskFlag, RiskTier } from '../types';
import { triggerRenewalEvent } from '../api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tierColors(tier: RiskTier) {
  if (tier === 'high')   return 'bg-red-100 text-red-800 border border-red-200';
  if (tier === 'medium') return 'bg-amber-100 text-amber-800 border border-amber-200';
  return                        'bg-green-100 text-green-800 border border-green-200';
}

function TierBadge({ tier }: { tier: RiskTier }) {
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wide ${tierColors(tier)}`}>
      {tier}
    </span>
  );
}

function ScoreDot({ score, tier }: { score: number; tier: RiskTier }) {
  const bar = tier === 'high' ? 'bg-red-400' : tier === 'medium' ? 'bg-amber-400' : 'bg-green-400';
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm font-semibold tabular-nums w-7">{score}</span>
      <div className="w-20 h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${bar}`} style={{ width: `${score}%` }} />
      </div>
    </div>
  );
}

function SignalRow({ label, active, activeText, inactiveText }: {
  label:        string;
  active:       boolean;
  activeText:   string;
  inactiveText: string;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${active ? 'bg-red-400' : 'bg-green-400'}`} />
      <span className="text-gray-500 w-36">{label}</span>
      <span className={active ? 'text-red-700 font-medium' : 'text-green-700'}>
        {active ? activeText : inactiveText}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Event button state
// ---------------------------------------------------------------------------

type EventStatus =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success'; eventId: string }
  | { kind: 'error'; message: string };

function EventButton({
  propertyId,
  residentId,
}: {
  propertyId: string;
  residentId: string;
}) {
  const [status, setStatus] = useState<EventStatus>({ kind: 'idle' });

  async function handleClick() {
    if (status.kind === 'loading') return;
    setStatus({ kind: 'loading' });
    try {
      const result = await triggerRenewalEvent(propertyId, residentId);
      setStatus({ kind: 'success', eventId: result.eventId });
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
    }
  }

  if (status.kind === 'success') {
    return (
      <div className="text-right">
        <span className="text-xs text-green-700 font-medium">Event queued</span>
        <p className="text-xs text-gray-400 font-mono truncate max-w-32" title={status.eventId}>
          {status.eventId.slice(-12)}
        </p>
      </div>
    );
  }

  if (status.kind === 'error') {
    return (
      <div className="text-right">
        <button
          onClick={handleClick}
          className="text-xs text-red-600 underline"
        >
          Retry
        </button>
        <p className="text-xs text-red-500 max-w-32 truncate" title={status.message}>
          {status.message}
        </p>
      </div>
    );
  }

  return (
    <button
      onClick={handleClick}
      disabled={status.kind === 'loading'}
      className="px-3 py-1.5 text-xs font-medium rounded-lg border border-blue-300
                 text-blue-700 bg-blue-50 hover:bg-blue-100 disabled:opacity-50
                 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
    >
      {status.kind === 'loading' ? 'Sending…' : 'Trigger Event'}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main table
// ---------------------------------------------------------------------------

interface Props {
  flags:      RiskFlag[];
  propertyId: string;
}

export default function RiskTable({ flags, propertyId }: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  if (flags.length === 0) {
    return (
      <div className="text-center py-12 text-gray-400 text-sm">
        No at-risk residents found.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-gray-200 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">
            <th className="pb-3 pr-4">Resident</th>
            <th className="pb-3 pr-4">Unit</th>
            <th className="pb-3 pr-4">Expiry</th>
            <th className="pb-3 pr-4">Score</th>
            <th className="pb-3 pr-4">Tier</th>
            <th className="pb-3 pr-4">Signals</th>
            <th className="pb-3 text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          {flags.map((flag) => {
            const isExpanded = expanded.has(flag.residentId);
            const { signals } = flag;

            return (
              <Fragment key={flag.residentId}>
                <tr
                  className="border-b border-gray-100 hover:bg-gray-50 transition-colors"
                >
                  <td className="py-3 pr-4 font-medium text-gray-900">{flag.name}</td>
                  <td className="py-3 pr-4 font-mono text-gray-600">{flag.unit}</td>
                  <td className="py-3 pr-4 tabular-nums text-gray-700">
                    {flag.daysToExpiry > 0
                      ? `${flag.daysToExpiry}d`
                      : <span className="text-amber-600 font-medium">MTM</span>
                    }
                  </td>
                  <td className="py-3 pr-4">
                    <ScoreDot score={flag.riskScore} tier={flag.riskTier} />
                  </td>
                  <td className="py-3 pr-4">
                    <TierBadge tier={flag.riskTier} />
                  </td>
                  <td className="py-3 pr-4">
                    <button
                      onClick={() => toggle(flag.residentId)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md
                                 text-xs font-medium text-gray-500 bg-gray-100
                                 hover:bg-gray-200 hover:text-gray-800
                                 active:bg-gray-300 transition-colors select-none"
                      aria-label={isExpanded ? 'Collapse signals' : 'Expand signals'}
                      aria-expanded={isExpanded}
                    >
                      <span className={`transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}>▶</span>
                      Signals
                    </button>
                  </td>
                  <td className="py-3 text-right">
                    <EventButton propertyId={propertyId} residentId={flag.residentId} />
                  </td>
                </tr>

                {isExpanded && (
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <td colSpan={7} className="px-4 py-3">
                      <div className="flex flex-wrap gap-x-8 gap-y-2">
                        <SignalRow
                          label="Days to expiry"
                          active={signals.daysToExpiryDays <= 90}
                          activeText={`${signals.daysToExpiryDays} days`}
                          inactiveText={`${signals.daysToExpiryDays} days`}
                        />
                        <SignalRow
                          label="Payment history"
                          active={signals.paymentHistoryDelinquent}
                          activeText="Delinquent"
                          inactiveText="On time"
                        />
                        <SignalRow
                          label="Renewal offer"
                          active={signals.noRenewalOfferYet}
                          activeText="No offer sent"
                          inactiveText="Offer pending"
                        />
                        <SignalRow
                          label="Rent vs market"
                          active={signals.rentGrowthAboveMarket}
                          activeText="Above market"
                          inactiveText="At market"
                        />
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
