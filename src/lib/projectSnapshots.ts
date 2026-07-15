import type { Project, ProjectSnapshot } from '@/types/project';

/** Freeze a project's identity onto a posted line so a later rename never rewrites history. */
export function createProjectSnapshot(project: Project, capturedAt: string): ProjectSnapshot {
  return { projectId: project.id, code: project.code, name: project.name, capturedAt };
}
