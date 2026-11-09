export type ProjectIgnores = Record<string, number>;

export type ProjectIgnoreUpdate = { cwd: string; until: number | null };
