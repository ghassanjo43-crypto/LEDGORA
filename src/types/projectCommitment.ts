/** Project commitment (§10) from a PO/subcontract/manual. Management data — NOT in the GL. */
export type CommitmentType = 'purchase-order' | 'subcontract' | 'manual';

export interface ProjectCommitment {
  id: string;
  projectId: string;
  type: CommitmentType;
  reference: string;
  description?: string;
  committedAmount: number;
  invoicedAmount: number;
  date: string;
  status: 'open' | 'closed';
  createdAt: string;
  updatedAt: string;
}
