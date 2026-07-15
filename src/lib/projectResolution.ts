import type { Project } from '@/types/project';
import { isProjectActiveOnDate } from '@/lib/projectValidation';

/** Default project resolution: explicit selection → customer default → none. */
export type ProjectDefaultSource = 'explicit' | 'customer' | 'none';

export interface DefaultProjectResolution {
  projectId?: string;
  source: ProjectDefaultSource;
}

export interface ResolveDefaultProjectParams {
  explicitProjectId?: string;
  customerDefaultProjectId?: string;
}

/** Resolve the default project by priority; never overrides an explicit selection. */
export function resolveDefaultProject(params: ResolveDefaultProjectParams): DefaultProjectResolution {
  if (params.explicitProjectId) return { projectId: params.explicitProjectId, source: 'explicit' };
  if (params.customerDefaultProjectId) return { projectId: params.customerDefaultProjectId, source: 'customer' };
  return { source: 'none' };
}

/** Projects selectable on a transaction dated `date` (open + within window). */
export function selectableProjects(projects: Project[], date: string, includeInactive = false): Project[] {
  return projects.filter((p) => (includeInactive ? true : isProjectActiveOnDate(p, date)));
}
