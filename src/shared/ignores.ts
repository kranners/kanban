export type ProjectIgnores = Record<string, number>;

export type ProjectIgnoreUpdate = { cwd: string; until: number | null };

export const ignoredAt = (ignores: ProjectIgnores, at: number): string[] =>
	Object.entries(ignores).flatMap(([cwd, until]) => (until > at ? [cwd] : []));
