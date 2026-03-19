export type RiskTier = 'high' | 'medium' | 'low';

export interface RiskSignals {
  daysToExpiryDays:         number;
  paymentHistoryDelinquent: boolean;
  noRenewalOfferYet:        boolean;
  rentGrowthAboveMarket:    boolean;
}

export interface RiskFlag {
  residentId:   string;
  name:         string;
  unitId:       string;
  unit:         string;
  leaseId:      string;
  riskScore:    number;
  riskTier:     RiskTier;
  daysToExpiry: number;
  signals:      RiskSignals;
}

export interface RiskSummary {
  propertyId:    string;
  calculatedAt:  string | null;
  flags:         RiskFlag[];
}

export interface CalculateResult {
  propertyId:     string;
  calculatedAt:   string;
  totalResidents: number;
  flaggedCount:   number;
  riskTiers:      { high: number; medium: number; low: number };
  flags:          RiskFlag[];
}
