import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type DocStore, maxDocTitle } from "../shared/types.ts";
import { annotationIdPattern } from "./annotations.ts";
import type { DocFiles } from "./docs.ts";
import { createStateFile, readState, writeAtomically } from "./stateFile.ts";

export type DocStoreRegistry = {
	current(): DocStore[];
	get(id: string): DocStore | null;
	create(title: unknown): DocStore | { error: string };
	rename(id: string, title: unknown): DocStore | { error: string } | null;
	remove(id: string): Promise<boolean>;
	touch(id: string): void;
	saved(): Promise<void>;
};

export type DocStoreRegistryOptions = {
	file: string;
	initial: DocStore[];
	files: Pick<DocFiles, "drop">;
	onChange: (stores: DocStore[]) => void;
	newId?: () => string;
	now?: () => number;
};

export const maxDocStores = 200;
export const untitledDocs = "Untitled docs";
export const docStoresFileName = "doc-stores.json";

const titleError = `title must be 1 to ${maxDocTitle} characters on one line`;

export const parseDocTitle = (value: unknown): string | { error: string } => {
	if (typeof value !== "string") return { error: titleError };
	const title = value.trim();
	return title === "" || title.length > maxDocTitle || /\p{Cc}/u.test(title)
		? { error: titleError }
		: title;
};

const isTime = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;

const parseDocStore = (value: unknown): DocStore | null => {
	if (typeof value !== "object" || value === null) return null;
	const { id, title, createdAt, updatedAt } = value as Record<string, unknown>;
	if (typeof id !== "string" || !annotationIdPattern.test(id)) return null;
	const parsed = parseDocTitle(title);
	if (typeof parsed !== "string") return null;
	if (!isTime(createdAt) || !isTime(updatedAt)) return null;
	return { id, title: parsed, createdAt, updatedAt };
};

export const byTitle = (a: DocStore, b: DocStore): number =>
	a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) ||
	(a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export const parseDocStores = (value: unknown): DocStore[] => {
	if (!Array.isArray(value)) return [];
	const kept = new Map<string, DocStore>();
	for (const raw of value) {
		const store = parseDocStore(raw);
		if (store && !kept.has(store.id)) kept.set(store.id, store);
	}
	return [...kept.values()].sort(byTitle);
};

export const loadDocStores = (file: string): Promise<DocStore[]> =>
	readState(file, parseDocStores);

export const createDocStoreRegistry = ({
	file,
	initial,
	files,
	onChange,
	newId = randomUUID,
	now = Date.now,
}: DocStoreRegistryOptions): DocStoreRegistry => {
	let stores = [...initial].sort(byTitle);
	const stored = createStateFile<DocStore[]>(file);

	const commit = (next: DocStore[]) => {
		stores = next.sort(byTitle);
		stored.write(stores);
		onChange(stores);
	};

	const get = (id: string) => stores.find((store) => store.id === id) ?? null;

	const replaced = (store: DocStore) =>
		stores.map((other) => (other.id === store.id ? store : other));

	return {
		current: () => stores,
		get,
		create(title) {
			const parsed = parseDocTitle(title);
			if (typeof parsed !== "string") return parsed;
			if (stores.length >= maxDocStores) {
				return { error: `There can be at most ${maxDocStores} doc stores` };
			}
			const time = now();
			const store: DocStore = {
				id: newId(),
				title: parsed,
				createdAt: time,
				updatedAt: time,
			};
			commit([...stores, store]);
			return store;
		},
		rename(id, title) {
			const known = get(id);
			if (!known) return null;
			const parsed = parseDocTitle(title);
			if (typeof parsed !== "string") return parsed;
			if (parsed === known.title) return known;
			const store = { ...known, title: parsed, updatedAt: now() };
			commit(replaced(store));
			return store;
		},
		async remove(id) {
			if (!get(id)) return false;
			commit(stores.filter((store) => store.id !== id));
			await files.drop(id);
			return true;
		},
		touch(id) {
			const known = get(id);
			if (known) commit(replaced({ ...known, updatedAt: now() }));
		},
		saved: stored.saved,
	};
};

export type DocStoreMigration = {
	stores: DocStore[];
	annotations: unknown;
	relations: unknown;
	changed: { annotations: boolean; relations: boolean; stores: boolean };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const touchesDocs = (relation: unknown): boolean =>
	isRecord(relation) &&
	[relation.from, relation.to].some(
		(end) => isRecord(end) && end.kind === "docs",
	);

// Moves doc stores off the board: "docs" annotations become registry entries
// (same id and title), relations to them go, and file folders nobody registered
// are kept under a placeholder title. Running it again changes nothing.
export const migrateDocStores = (
	{
		stores,
		annotations,
		relations,
		folders,
	}: {
		stores: readonly DocStore[];
		annotations: unknown;
		relations: unknown;
		folders: readonly string[];
	},
	now: number,
): DocStoreMigration => {
	const registry = new Map(stores.map((store) => [store.id, store]));
	const knownBefore = registry.size;
	let keptAnnotations = annotations;
	if (isRecord(annotations)) {
		const rest: Record<string, unknown> = {};
		for (const [id, raw] of Object.entries(annotations)) {
			if (!isRecord(raw) || raw.kind !== "docs") {
				rest[id] = raw;
				continue;
			}
			if (!annotationIdPattern.test(id) || registry.has(id)) continue;
			const title = parseDocTitle(raw.title);
			registry.set(id, {
				id,
				title: typeof title === "string" ? title : untitledDocs,
				createdAt: now,
				updatedAt: now,
			});
		}
		if (Object.keys(rest).length !== Object.keys(annotations).length) {
			keptAnnotations = rest;
		}
	}
	for (const id of folders) {
		if (annotationIdPattern.test(id) && !registry.has(id)) {
			registry.set(id, {
				id,
				title: untitledDocs,
				createdAt: now,
				updatedAt: now,
			});
		}
	}
	const keptRelations = Array.isArray(relations)
		? relations.filter((relation) => !touchesDocs(relation))
		: relations;
	const relationsChanged =
		Array.isArray(relations) &&
		(keptRelations as unknown[]).length !== relations.length;
	return {
		stores: [...registry.values()].sort(byTitle),
		annotations: keptAnnotations,
		relations: keptRelations,
		changed: {
			stores: registry.size !== knownBefore,
			annotations: keptAnnotations !== annotations,
			relations: relationsChanged,
		},
	};
};

const readRaw = async (file: string): Promise<unknown> => {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return undefined;
	}
};

const foldersWithFiles = async (dir: string): Promise<string[]> => {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
	const found: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !annotationIdPattern.test(entry.name)) continue;
		const inside = await readdir(join(dir, entry.name), {
			recursive: true,
			withFileTypes: true,
		}).catch(() => []);
		if (inside.some((file) => file.isFile())) found.push(entry.name);
	}
	return found;
};

// Unlike a StateFile, which logs a failed write and carries on, this rejects,
// so the migration stops before it drops anything the registry doesn't hold.
const writeState = (file: string, value: unknown) =>
	writeAtomically(file, `${JSON.stringify(value)}\n`);

// Runs the migration against the state directory before any store loads, so
// the annotations and relations loaders never see doc stores. The registry is
// written first and any failure throws: annotations and relations are only
// rewritten once it is on disk, so a failure or crash part way leaves the old
// files to migrate again.
export const migrateDocStoreFiles = async (
	{
		stateDir,
		annotationsFile,
		relationsFile,
	}: { stateDir: string; annotationsFile: string; relationsFile: string },
	now: number = Date.now(),
): Promise<DocStore[]> => {
	const storesFile = join(stateDir, docStoresFileName);
	const migration = migrateDocStores(
		{
			stores: await loadDocStores(storesFile),
			annotations: await readRaw(annotationsFile),
			relations: await readRaw(relationsFile),
			folders: await foldersWithFiles(join(stateDir, "docs")),
		},
		now,
	);
	if (migration.changed.stores) {
		await writeState(storesFile, migration.stores);
	}
	if (migration.changed.annotations) {
		await writeState(annotationsFile, migration.annotations);
	}
	if (migration.changed.relations) {
		await writeState(relationsFile, migration.relations);
	}
	return migration.stores;
};
