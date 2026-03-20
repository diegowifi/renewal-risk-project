import { AppError } from '../errors';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function requireUuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw AppError.badRequest(`${name} must be a valid UUID`);
  }
  return value;
}

export function requireDate(value: unknown, name: string): string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw AppError.badRequest(`${name} must be a date in YYYY-MM-DD format`);
  }
  // Ensure the date is actually valid (e.g. rejects "2025-02-30")
  const d = new Date(`${value}T00:00:00.000Z`);
  if (isNaN(d.getTime())) {
    throw AppError.badRequest(`${name} is not a valid calendar date`);
  }
  return value;
}
