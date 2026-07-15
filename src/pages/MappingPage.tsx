import { Alert } from '@/components/ui/Alert';
import { IFRSMappingTable } from '@/components/mapping/IFRSMappingTable';

export function MappingPage() {
  return (
    <div className="space-y-5">
      <Alert variant="info" title="How this maps to IFRS">
        Accounts are grouped by the IFRS-style financial statement they feed:
        Statement of Financial Position, Profit or Loss, Other Comprehensive
        Income, Statement of Changes in Equity and the Statement of Cash Flows.
        These are internal management codes aligned with IFRS presentation
        principles — not official IFRS codes.
      </Alert>
      <IFRSMappingTable />
    </div>
  );
}
