import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, posix, relative, sep } from "node:path";

export type FileListing =
	| { ok: true; files: string[] }
	| { ok: false; error: string };

export type FileListOptions = {
	cwd: string;
	query: string;
	claudeHome: string;
	limit?: number;
	scanLimit?: number;
	depthLimit?: number;
};

const skippedDirectories = new Set([".git", "node_modules"]);
const gitTimeoutMs = 5000;

const within = (parent: string, child: string): boolean => {
	const path = relative(parent, child);
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

const resolved = async (path: string): Promise<string | null> => {
	try {
		return await realpath(path);
	} catch {
		return null;
	}
};

const gitFiles = (cwd: string, scanLimit: number): Promise<string[] | null> =>
	new Promise((resolve) => {
		execFile(
			"git",
			[
				"-C",
				cwd,
				"ls-files",
				"--cached",
				"--others",
				"--exclude-standard",
				"-z",
			],
			{ timeout: gitTimeoutMs, maxBuffer: 32 * 1024 * 1024 },
			(error, stdout) => {
				if (error) return resolve(null);
				resolve(
					stdout
						.split("\0")
						.filter((path) => path !== "")
						.slice(0, scanLimit),
				);
			},
		);
	});

const walkFiles = async (
	cwd: string,
	scanLimit: number,
	depthLimit: number,
): Promise<string[]> => {
	const found: string[] = [];
	const queue: { dir: string; depth: number }[] = [{ dir: "", depth: 0 }];
	while (queue.length > 0 && found.length < scanLimit) {
		const next = queue.shift();
		if (!next) break;
		let entries: Dirent[];
		try {
			entries = await readdir(join(cwd, next.dir), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const path = next.dir ? `${next.dir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (skippedDirectories.has(entry.name) || entry.name.startsWith(".")) {
					continue;
				}
				if (next.depth < depthLimit) {
					queue.push({ dir: path, depth: next.depth + 1 });
				}
			} else {
				found.push(path);
			}
			if (found.length >= scanLimit) break;
		}
	}
	return found;
};

const withDirectories = (files: string[]): string[] => {
	const directories = new Set<string>();
	for (const file of files) {
		let dir = posix.dirname(file);
		while (dir !== "." && dir !== "" && !directories.has(`${dir}/`)) {
			directories.add(`${dir}/`);
			dir = posix.dirname(dir);
		}
	}
	return [...directories, ...files];
};

export const scoreFile = (path: string, query: string): number | null => {
	if (query === "") return 0;
	const lower = path.toLowerCase();
	const name = posix.basename(lower.replace(/\/$/, ""));
	if (name.startsWith(query)) return 0;
	if (name.includes(query)) return 1;
	if (lower.includes(query)) return 2;
	let at = 0;
	for (const character of query) {
		at = lower.indexOf(character, at);
		if (at === -1) return null;
		at += 1;
	}
	return 3;
};

const cache = new Map<string, { at: number; files: string[] }>();
const cacheMs = 10_000;

export const listFiles = async (
	options: FileListOptions,
): Promise<FileListing> => {
	const limit = options.limit ?? 50;
	const scanLimit = options.scanLimit ?? 50_000;
	const depthLimit = options.depthLimit ?? 8;
	if (!isAbsolute(options.cwd)) {
		return { ok: false, error: "The session's directory is not absolute" };
	}
	const cwd = await resolved(options.cwd);
	const home = (await resolved(options.claudeHome)) ?? options.claudeHome;
	if (!cwd || !(await stat(cwd).catch(() => null))?.isDirectory()) {
		return { ok: false, error: "The session's directory is gone" };
	}
	if (within(home, cwd)) {
		return {
			ok: false,
			error: "Files under Claude Code's own directory are not listed",
		};
	}
	const key = `${cwd}\0${scanLimit}\0${depthLimit}`;
	const cached = cache.get(key);
	let files = cached && Date.now() - cached.at < cacheMs ? cached.files : null;
	if (!files) {
		const listed =
			(await gitFiles(cwd, scanLimit)) ??
			(await walkFiles(cwd, scanLimit, depthLimit));
		files = withDirectories(
			listed.filter((path) => {
				if (path.split("/").includes("..") || isAbsolute(path)) return false;
				return !within(home, join(cwd, path.split("/").join(sep)));
			}),
		);
		cache.set(key, { at: Date.now(), files });
	}
	const query = options.query.trim().toLowerCase();
	return {
		ok: true,
		files: files
			.flatMap((path) => {
				const score = scoreFile(path, query);
				return score === null ? [] : [{ path, score }];
			})
			.sort((a, b) => a.score - b.score || a.path.length - b.path.length)
			.slice(0, limit)
			.map(({ path }) => path),
	};
};
