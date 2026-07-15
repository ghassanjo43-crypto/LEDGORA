export type CashFlowActivity = 'operating' | 'investing' | 'financing' | 'cash-transfer' | 'unclassified';

export type CashFlowLineSource = 'income-statement' | 'balance-movement' | 'cash-journal-analysis' | 'policy-adjustment';

export interface CashFlowLine {
  id: string;
  label: string;
  amount: number;
  comparativeAmount?: number;
  activity: CashFlowActivity;
  accountIds: string[];
  journalEntryIds: string[];
  source: CashFlowLineSource;
  isNonCash?: boolean;
  isWorkingCapital?: boolean;
  warning?: string;
}

export type CashFlowWarningSeverity = 'error' | 'warning' | 'info';
export interface CashFlowWarning {
  id: string;
  severity: CashFlowWarningSeverity;
  message: string;
  reference?: string;
}

export interface CashFlowPeriod {
  start: string;
  end: string;
}

export interface CashFlowPolicy {
  interestPaid: 'operating' | 'financing';
  interestReceived: 'operating' | 'investing';
  dividendsPaid: 'financing' | 'operating';
  dividendsReceived: 'operating' | 'investing';
}

export const DEFAULT_CASH_FLOW_POLICY: CashFlowPolicy = {
  interestPaid: 'operating',
  interestReceived: 'investing',
  dividendsPaid: 'financing',
  dividendsReceived: 'investing',
};

export interface CashFlowStatement {
  entityId: string;
  periodStart: string;
  periodEnd: string;
  comparativePeriod?: CashFlowPeriod;
  currency: string;

  profitForPeriod: number;
  nonCashAdjustments: CashFlowLine[];
  workingCapitalChanges: CashFlowLine[];

  cashGeneratedFromOperations: number;
  taxesPaid: number;
  interestPaid: number;
  netOperatingCashFlow: number;

  investingActivities: CashFlowLine[];
  netInvestingCashFlow: number;

  financingActivities: CashFlowLine[];
  netFinancingCashFlow: number;

  exchangeRateEffect: number;
  netChangeInCash: number;
  openingCash: number;
  calculatedClosingCash: number;
  balanceSheetClosingCash: number;
  reconciliationDifference: number;
  isReconciled: boolean;

  /** Present only when a comparative period is selected. */
  comparativeTotals?: {
    profitForPeriod: number;
    netOperatingCashFlow: number;
    netInvestingCashFlow: number;
    netFinancingCashFlow: number;
    netChangeInCash: number;
    openingCash: number;
    calculatedClosingCash: number;
  };
  hasComparative: boolean;

  unclassifiedItems: CashFlowWarning[];
  warnings: CashFlowWarning[];
}
