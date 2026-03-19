# Frontend — Renewal Risk Dashboard

React + TypeScript SPA for viewing and acting on resident renewal risk scores.

## Stack

- **Framework**: React 19 + TypeScript
- **Build tool**: Vite 8
- **Styling**: Tailwind CSS v4 (via `@tailwindcss/vite` plugin — no `tailwind.config.js`)
- **Routing**: React Router v7

## Running locally

```bash
npm install
npm run dev     # → http://localhost:5173
```

The Vite dev server proxies all `/api` requests to `http://localhost:3000`, so
the backend must be running for API calls to work.

## Pages

### `/` — Landing

Enter a property UUID to open its dashboard. Validates UUID format before navigating.

### `/properties/:propertyId/renewal-risk` — Dashboard

| Feature | Details |
|---|---|
| Load scores | Calls `GET /api/v1/properties/:id/renewal-risk` on mount |
| Empty state | "No scores yet" prompt when `calculatedAt` is null |
| Calculate button | Posts to `/renewal-risk/calculate` with a configurable `asOfDate`, reloads scores on success |
| Tier filter | All / High / Medium / Low tabs with live counts |
| Risk table | Name, unit, days to expiry, score (with progress bar), tier badge |
| Expandable signals | Click ▸ to reveal all 4 risk signals with red/green indicators |
| Trigger Event | Per-row button: idle → loading → success (shows event ID) or error (with retry) |

## File structure

```
src/
  api.ts                    # fetch helpers (fetchLatestRisk, calculateRisk, triggerRenewalEvent)
  types.ts                  # RiskFlag, RiskSignals, RiskSummary, CalculateResult
  App.tsx                   # BrowserRouter + routes
  pages/
    LandingPage.tsx
    RenewalRiskPage.tsx     # data fetching, calculate form, tier filter
  components/
    RiskTable.tsx           # table, expandable signals, EventButton
```
