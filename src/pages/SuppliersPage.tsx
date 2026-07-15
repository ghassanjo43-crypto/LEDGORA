import { EntityDirectory } from '@/components/entities/EntityDirectory';

export function SuppliersPage() {
  return (
    <EntityDirectory
      scope="supplier"
      title="Supplier directory"
      description="Entities who invoice us. Includes parties that are both customer and supplier."
    />
  );
}
