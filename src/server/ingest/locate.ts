import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const slugLimit = 200;

export function projectSlug(cwd: string): string | null {
	const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
	return slug.length <= slugLimit ? slug : null;
}

export function locateTranscript(
	claudeHome: string,
	sessionId: string,
	cwd: string,
): string | null {
	const projects = join(claudeHome, "projects");
	const slug = projectSlug(cwd);
	if (slug) {
		const direct = join(projects, slug, `${sessionId}.jsonl`);
		if (existsSync(direct)) return direct;
	}
	let dirs: string[];
	try {
		dirs = readdirSync(projects);
	} catch {
		return null;
	}
	return (
		dirs
			.map((dir) => join(projects, dir, `${sessionId}.jsonl`))
			.flatMap((path) => {
				try {
					return [{ path, mtimeMs: statSync(path).mtimeMs }];
				} catch {
					return [];
				}
			})
			.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.path ?? null
	);
}
