import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type Projects = Record<string, Record<string, unknown>>;

const projectsOf = (config: unknown): Projects => {
	const projects = (config as { projects?: unknown } | null)?.projects;
	return typeof projects === "object" && projects !== null
		? (projects as Projects)
		: {};
};

const readConfig = async (file: string): Promise<Record<string, unknown>> => {
	try {
		const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
		return typeof parsed === "object" && parsed !== null
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
};

export function trustedRoot(config: unknown, cwd: string): string | null {
	const projects = projectsOf(config);
	for (let path = cwd; ; path = dirname(path)) {
		if (projects[path]?.hasTrustDialogAccepted === true) return path;
		if (dirname(path) === path) return null;
	}
}

export const profileConfig = (configDir: string): string =>
	join(configDir, ".claude.json");

export async function mirrorTrust(
	from: string,
	to: string,
	cwd: string,
): Promise<boolean> {
	const root = trustedRoot(await readConfig(from), cwd);
	if (root === null) return false;
	const target = await readConfig(to);
	if (trustedRoot(target, cwd) !== null) return false;
	const projects = projectsOf(target);
	const next = {
		...target,
		projects: {
			...projects,
			[root]: { ...projects[root], hasTrustDialogAccepted: true },
		},
	};
	const temporary = `${to}.kanban-${process.pid}`;
	await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
		mode: 0o600,
	});
	await rename(temporary, to);
	return true;
}
