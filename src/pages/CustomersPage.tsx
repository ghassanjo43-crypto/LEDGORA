import { EntityDirectory } from '@/components/entities/EntityDirectory';

export function CustomersPage() {
  return (
    <EntityDirectory
      scope="customer"
      title="Customer directory"
      description="Entities we invoice. Includes parties that are both customer and supplier."
    />
  );
}
