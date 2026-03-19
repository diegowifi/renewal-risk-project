import type { RiskSummary, CalculateResult } from './types';

const BASE = '/api/v1';

async function handleResponse<T>(res: Response): Promise<T> {
  if (res.ok) return res.json() as Promise<T>;
  const body = await res.json().catch(() => ({})) as { error?: { message?: string } };
  throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
}

export async function fetchLatestRisk(propertyId: string): Promise<RiskSummary> {
  const res = await fetch(`${BASE}/properties/${propertyId}/renewal-risk`);
  return handleResponse<RiskSummary>(res);
}

export async function calculateRisk(
  propertyId: string,
  asOfDate: string,
): Promise<CalculateResult> {
  const res = await fetch(
    `${BASE}/properties/${propertyId}/renewal-risk/calculate`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ asOfDate }),
    },
  );
  return handleResponse<CalculateResult>(res);
}

export async function triggerRenewalEvent(
  propertyId: string,
  residentId: string,
): Promise<{ eventId: string; webhookId: string }> {
  const res = await fetch(
    `${BASE}/properties/${propertyId}/residents/${residentId}/renewal-event`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' } },
  );
  return handleResponse<{ eventId: string; webhookId: string }>(res);
}
