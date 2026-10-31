import {
	lstat,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	rmdir,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { isDocPath, maxDocBytes, maxDocFiles } from "../shared/docPaths.ts";
import type { DocFile, DocIndex } from "../shared/types.ts";
import { annotationIdPattern } from "./annotations.ts";

export type DocWrite = DocFile | { error: string };

export type DocFiles = {
	index(): DocIndex;
	read(store: string, path: string): Promise<Buffer | null>;
	write(store: string, path: string, bytes: Uint8Array): Promise<DocWrite>;
	remove(store: string, path: string): Promise<boolean>;
	drop(store: string): Promise<void>;
};

export type DocFilesOptions = {
	dir: string;
	onChange: (index: DocIndex) => void;
};

export const maxStoreBytes = 100 * 1024 * 1024;

type Store = Map<string, DocFile>;

const megabytes = (bytes: number) => `${bytes / (1024 * 1024)} MB`;

const byPath = (a: DocFile, b: DocFile) =>
	a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

const prefixesOf = (path: string) =>
	path.split("/").map((_, n, segments) => segments.slice(0, n + 1).join("/"));

const caseClash = (files: Store, path: string): string | undefined => {
	const wanted = new Map(
		prefixesOf(path).map((prefix) => [prefix.toLowerCase(), prefix]),
	);
	for (const existing of files.keys()) {
		for (const prefix of prefixesOf(existing)) {
			const match = wanted.get(prefix.toLowerCase());
			if (match !== undefined && match !== prefix) return prefix;
		}
	}
	return undefined;
};

const indexStore = async (root: string): Promise<Store> => {
	const files: Store = new Map();
	const entries = await readdir(root, {
		recursive: true,
		withFileTypes: true,
	}).catch(() => []);
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const name = join(entry.parentPath, entry.name);
		const path = relative(root, name).split(sep).join("/");
		if (!isDocPath(path)) continue;
		const info = await lstat(name).catch(() => null);
		if (!info?.isFile()) continue;
		files.set(path, {
			path,
			size: info.size,
			updatedAt: Math.round(info.mtimeMs),
		});
	}
	return files;
};

const loadStores = async (dir: string): Promise<Map<string, Store>> => {
	const stores = new Map<string, Store>();
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (!entry.isDirectory() || !annotationIdPattern.test(entry.name)) {
			continue;
		}
		const files = await indexStore(join(dir, entry.name));
		if (files.size > 0) stores.set(entry.name, files);
	}
	return stores;
};

const removeEmptyParents = async (root: string, file: string) => {
	for (
		let folder = dirname(file);
		relative(root, folder) !== "";
		folder = dirname(folder)
	) {
		try {
			await rmdir(folder);
		} catch {
			return;
		}
	}
};

export const loadDocFiles = async ({
	dir,
	onChange,
}: DocFilesOptions): Promise<DocFiles> => {
	await mkdir(dir, { recursive: true });
	const stores = await loadStores(dir);
	const queues = new Map<string, Promise<unknown>>();
	let cached: DocIndex | null = null;
	let temporaries = 0;

	const index = (): DocIndex => {
		cached ??= Object.fromEntries(
			[...stores].map(([id, files]) => [id, [...files.values()].sort(byPath)]),
		);
		return cached;
	};

	const changed = () => {
		cached = null;
		onChange(index());
	};

	const queued = <T>(store: string, task: () => Promise<T>): Promise<T> => {
		const run = (queues.get(store) ?? Promise.resolve()).then(task);
		queues.set(
			store,
			run.catch(() => {}),
		);
		return run;
	};

	const located = (store: string, path: string) =>
		join(dir, store, ...path.split("/"));

	const throughLink = async (store: string, path: string) => {
		for (const prefix of ["", ...prefixesOf(path)]) {
			const info = await lstat(located(store, prefix)).catch(() => null);
			if (info?.isSymbolicLink()) return true;
		}
		return false;
	};

	const save = async (
		store: string,
		path: string,
		bytes: Uint8Array,
	): Promise<DocWrite> => {
		const files = stores.get(store) ?? new Map<string, DocFile>();
		const previous = files.get(path);
		const clash = caseClash(files, path);
		if (clash) {
			return {
				error: `${path} clashes with ${clash}: names that differ only in case are the same file on this Mac`,
			};
		}
		if (!previous && files.size >= maxDocFiles) {
			return { error: `A doc store holds at most ${maxDocFiles} files` };
		}
		const total = [...files.values()].reduce((sum, file) => sum + file.size, 0);
		if (total - (previous?.size ?? 0) + bytes.length > maxStoreBytes) {
			return { error: `A doc store holds at most ${megabytes(maxStoreBytes)}` };
		}
		if (await throughLink(store, path)) {
			return { error: `Couldn't write ${path}` };
		}
		const file = located(store, path);
		const temporary = join(
			dirname(file),
			`.${path.slice(path.lastIndexOf("/") + 1)}.${process.pid}.${++temporaries}.tmp`,
		);
		try {
			await mkdir(dirname(file), { recursive: true });
			await writeFile(temporary, bytes);
			await rename(temporary, file);
		} catch {
			await rm(temporary, { force: true });
			return { error: `Couldn't write ${path}` };
		}
		const info = await stat(file);
		const written = {
			path,
			size: info.size,
			updatedAt: Math.round(info.mtimeMs),
		};
		files.set(path, written);
		stores.set(store, files);
		changed();
		return written;
	};

	return {
		index,
		async read(store, path) {
			if (!stores.get(store)?.has(path)) return null;
			if (await throughLink(store, path)) return null;
			return readFile(located(store, path)).catch(() => null);
		},
		async write(store, path, bytes) {
			if (!annotationIdPattern.test(store) || !isDocPath(path)) {
				return { error: `${path} isn't a valid doc path` };
			}
			if (bytes.length > maxDocBytes) {
				return { error: `A doc is at most ${megabytes(maxDocBytes)}` };
			}
			return queued(store, () => save(store, path, bytes));
		},
		remove(store, path) {
			return queued(store, async () => {
				const files = stores.get(store);
				if (!files?.has(path)) return false;
				const file = located(store, path);
				await rm(file, { force: true });
				await removeEmptyParents(join(dir, store), file);
				files.delete(path);
				if (files.size === 0) stores.delete(store);
				changed();
				return true;
			});
		},
		async drop(store) {
			if (!annotationIdPattern.test(store)) return;
			return queued(store, async () => {
				await rm(join(dir, store), { recursive: true, force: true }).catch(
					() => {},
				);
				if (stores.delete(store)) changed();
			});
		},
	};
};
