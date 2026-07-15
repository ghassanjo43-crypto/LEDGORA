import { EntityDirectory } from '@/components/entities/EntityDirectory';

export function EntitiesPage() {
  return (
    <EntityDirectory
      scope="all"
      title="All business entities"
      description="One shared record per party — a customer, a supplier, or both. Never duplicated."
    />
  );
}
