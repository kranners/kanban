import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** The file the build writes beside the page, naming the page's build. */
export const buildIdFile = "build-id";

/**
 * Reads the build of the page in `dist`, again whenever its file changes, so
 * a page built after the server started is reported as it is, and a page that
 * reloads for a new build never meets an older id and reloads again.
 */
export const buildIdReader = (dist: string): (() => string | null) => {
	const file = join(dist, buildIdFile);
	let seen: { mtimeMs: number; id: string | null } | null = null;
	return () => {
		try {
			const { mtimeMs } = statSync(file);
			if (seen?.mtimeMs !== mtimeMs) {
				const id = readFileSync(file, "utf8").trim();
				seen = { mtimeMs, id: /^[A-Za-z0-9._-]{1,64}$/.test(id) ? id : null };
			}
			return seen.id;
		} catch {
			return null;
		}
	};
};
