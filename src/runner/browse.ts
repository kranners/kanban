// The folder browser's view of one machine's disk. The runner answers the
// hub's browse commands with it, and the hub uses it for its own disk, so a
// path is always looked up on the machine the session will run on.
import { readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { FolderBrowse, FolderListing } from "../shared/types.ts";
import { cwdCandidates } from "./sessions.ts";

/** At most this many subfolders go back, so a huge folder stays one small answer. */
export const maxFolders = 1000;
const maxPathLength = 4096;

export type BrowseOptions = {
	/** How the board names this machine, in listings and errors. */
	machine: string;
	home: string;
	/** The hub's home folder, so a path from the hub maps onto this one. */
	hubHome?: string | null;
	paths?: readonly (readonly [string, string])[];
	isDirectory?: (path: string) => Promise<boolean>;
	list?: (path: string) => Promise<string[]>;
	separator?: string;
};

const isDirectoryOnDisk = async (path: string): Promise<boolean> => {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
};

// Directories and links to directories, never files; hidden ones are left out.
const listOnDisk = async (path: string): Promise<string[]> => {
	const entries = await readdir(path, { withFileTypes: true });
	const names: string[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		if (entry.isDirectory()) names.push(entry.name);
		else if (
			entry.isSymbolicLink() &&
			(await isDirectoryOnDisk(join(path, entry.name)))
		)
			names.push(entry.name);
	}
	return names;
};

/** ~ and ~/x (or ~\x on Windows) on this machine's own home folder. */
export const expandHome = (path: string, home: string): string => {
	if (path === "~") return home;
	if (path.startsWith("~/") || path.startsWith("~\\"))
		return resolve(home, path.slice(2));
	return path;
};

/** Where browsing starts when no folder is given: ~/workspace if there is one. */
export const defaultFolder = async (
	home: string,
	isDirectory: (path: string) => Promise<boolean>,
): Promise<string> => {
	const workspace = join(home, "workspace");
	return (await isDirectory(workspace)) ? workspace : home;
};

const trimTrailing = (path: string): string => {
	const trimmed = path.replace(/[/\\]+$/, "");
	return trimmed === "" || /^[A-Za-z]:$/.test(trimmed) ? path : trimmed;
};

export const browseFolder = async (
	requested: string | null,
	options: BrowseOptions,
): Promise<FolderBrowse> => {
	const {
		machine,
		home,
		hubHome = null,
		paths = [],
		isDirectory = isDirectoryOnDisk,
		list = listOnDisk,
	} = options;
	const typed = requested?.trim() ?? "";
	if (typed.length > maxPathLength) {
		return { ok: false, error: "That path is too long" };
	}
	let path: string;
	if (typed === "") path = await defaultFolder(home, isDirectory);
	else {
		const expanded = expandHome(typed, home);
		if (!isAbsolute(expanded)) {
			return {
				ok: false,
				error: `Type a full path on ${machine}, or start it with ~ for its home folder`,
			};
		}
		path = trimTrailing(resolve(expanded));
		if (!(await isDirectory(path))) {
			// A hub path (another machine's home) still finds its twin here.
			let twin: string | null = null;
			// Mapped from the path as typed: resolve() on Windows would prefix a drive.
			for (const candidate of cwdCandidates(trimTrailing(expanded), {
				hubHome,
				home,
				paths,
				separator: options.separator ?? sep,
			})) {
				if (await isDirectory(candidate)) {
					twin = candidate;
					break;
				}
			}
			if (twin === null) {
				return { ok: false, error: `${typed} isn't a folder on ${machine}` };
			}
			path = twin;
		}
	}
	let names: string[];
	try {
		names = await list(path);
	} catch (error) {
		return {
			ok: false,
			error: `Couldn't read ${path} on ${machine}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`,
		};
	}
	names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
	const parent = dirname(path);
	const listing: FolderListing = {
		machine,
		path,
		home,
		parent: parent === path ? null : parent,
		folders: names.slice(0, maxFolders),
		truncated: names.length > maxFolders,
	};
	return { ok: true, listing };
};
