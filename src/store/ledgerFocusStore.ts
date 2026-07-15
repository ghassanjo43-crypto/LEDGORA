import { create } from 'zustand';

interface LedgerFocusRequest {
  accountId: string;
  from: string;
  to: string;
}

interface LedgerFocusState {
  /** Transient drill-down request from the Trial Balance to the General Ledger. */
  request: LedgerFocusRequest | null;
  requestLedgerFocus: (req: LedgerFocusRequest) => void;
  clearLedgerFocus: () => void;
}

/** Not persisted — a one-shot channel so Trial Balance can open an account in the GL. */
export const useLedgerFocus = create<LedgerFocusState>((set) => ({
  request: null,
  requestLedgerFocus: (request) => set({ request }),
  clearLedgerFocus: () => set({ request: null }),
}));
