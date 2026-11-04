import { AsyncLocalStorage } from "node:async_hooks";
import type {
	Annotation,
	Placement,
	Region,
	Relation,
} from "../shared/types.ts";
import type { AnnotationStore } from "./annotations.ts";
import type { CloudRecord } from "./cloud.ts";
import type { ColourStore } from "./colours.ts";
import type { LayoutStore } from "./layout.ts";
import type { RegionStore } from "./regions.ts";
import type { RelationStore } from "./relations.ts";

/** Who made a change: "you" from the board's page, `butler:<thread>` from Butler. */
export type Actor = string;

/** One kind of thing on the board the history can put back. */
export type Part = {
	/** Everything of this kind, by key, for diffing a store call. */
	read(): Record<string, unknown>;
	/** One thing, or null when it isn't there. */
	get(key: string): unknown;
	/** Puts one thing back, or takes it away when value is null; says why not. */
	write(key: string, value: unknown): Promise<string | null> | string | null;
	noun: [string, string];
	verbs: { added: string; removed: string; changed: string };
	/** Set for a part that asks another service, which can refuse, so it goes first. */
	remote?: boolean;
	/** A name to show for a lone change, such as a cloud session's title. */
	name?(value: unknown): string | null;
};

type Values = Record<string, Record<string, unknown>>;

export type Entry = {
	actor: Actor;
	at: number;
	before: Values;
	after: Values;
};

export type UndoOutcome =
	| { ok: true; label: string; skipped: number }
	| { ok: false; error: string };

export type Undo = {
	/** Runs `run` as `actor`; changes made inside are recorded under it, or not at all for null. */
	as<T>(actor: Actor | null, run: () => T): T;
	/** Wraps a store's mutators so calls made as an actor are recorded. */
	track<S extends object>(part: string, store: S, methods: (keyof S)[]): S;
	/** Records a change made outside a tracked store, such as archiving a cloud session. */
	note(part: string, key: string, before: unknown, after: unknown): void;
	undo(): Promise<UndoOutcome>;
	redo(): Promise<UndoOutcome>;
	/** What cmd+z and cmd+shift+z would do now. */
	peek(): { undo: string | null; redo: string | null };
};

export type UndoOptions = {
	parts: Record<string, Part>;
	now?: () => number;
	limit?: number;
};

/** Your changes this close together are one step, such as several notes dragged at once. */
export const yourGapMs = 800;
/** Butler's changes for one request are one step, such as a whole tidy. */
export const butlerGapMs = 2 * 60_000;
export const maxEntries = 100;

const same = (a: unknown, b: unknown): boolean =>
	JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const gapFor = (actor: Actor): number =>
	actor.startsWith("butler:") ? butlerGapMs : yourGapMs;

const article = (noun: string) => (/^[aeiou]/.test(noun) ? "an" : "a");

export const describe = (entry: Entry, parts: Record<string, Part>): string => {
	const phrases: string[] = [];
	for (const [name, before] of Object.entries(entry.before)) {
		const part = parts[name];
		if (!part) continue;
		const after = entry.after[name] ?? {};
		const counts = { added: 0, removed: 0, changed: 0 };
		let lone: unknown = null;
		for (const key of Object.keys(before)) {
			const was = before[key] ?? null;
			const now = after[key] ?? null;
			lone = was ?? now;
			if (was === null) counts.added++;
			else if (now === null) counts.removed++;
			else counts.changed++;
		}
		for (const kind of ["added", "removed", "changed"] as const) {
			const count = counts[kind];
			if (count === 0) continue;
			const [one, many] = part.noun;
			const named = count === 1 && part.name ? part.name(lone) : null;
			const what = named
				? `${one} ${named}`
				: count === 1
					? `${article(one)} ${one}`
					: `${count} ${many}`;
			phrases.push(`${part.verbs[kind]} ${what}`);
		}
	}
	const said = phrases.join(", ") || "a change";
	const text = said.charAt(0).toUpperCase() + said.slice(1);
	return entry.actor.startsWith("butler:") ? `Butler: ${text}` : text;
};

const diff = (
	before: Record<string, unknown>,
	after: Record<string, unknown>,
): [Record<string, unknown>, Record<string, unknown>] => {
	const was: Record<string, unknown> = {};
	const now: Record<string, unknown> = {};
	for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
		if (same(before[key], after[key])) continue;
		was[key] = before[key] ?? null;
		now[key] = after[key] ?? null;
	}
	return [was, now];
};

export const createUndo = ({
	parts,
	now = Date.now,
	limit = maxEntries,
}: UndoOptions): Undo => {
	const actors = new AsyncLocalStorage<Actor | null>();
	const done: Entry[] = [];
	const undone: Entry[] = [];
	let queue: Promise<unknown> = Promise.resolve();

	const record = (part: string, before: unknown, after: unknown, key: string) =>
		recordMany(part, { [key]: before }, { [key]: after });

	const recordMany = (
		part: string,
		before: Record<string, unknown>,
		after: Record<string, unknown>,
	) => {
		const actor = actors.getStore();
		if (!actor || Object.keys(before).length === 0) return;
		const time = now();
		const last = done.at(-1);
		const entry =
			last && last.actor === actor && time - last.at < gapFor(actor)
				? last
				: undefined;
		const into = entry ?? { actor, at: time, before: {}, after: {} };
		const was = into.before[part] ?? {};
		const will = into.after[part] ?? {};
		into.before[part] = was;
		into.after[part] = will;
		for (const key of Object.keys(before)) {
			if (!(key in was)) was[key] = before[key] ?? null;
			will[key] = after[key] ?? null;
			if (same(was[key], will[key])) {
				delete was[key];
				delete will[key];
			}
		}
		into.at = time;
		if (!entry) done.push(into);
		while (done.length > limit) done.shift();
		undone.length = 0;
	};

	/** Puts every part back to `to`, where it still reads `from`; remote parts go first, since they can refuse. */
	const apply = async (
		entry: Entry,
		from: Values,
		to: Values,
	): Promise<{ skipped: number } | { error: string }> => {
		let skipped = 0;
		const steps: [Part, string, unknown][] = [];
		for (const [name, values] of Object.entries(to)) {
			const part = parts[name];
			if (!part) continue;
			for (const [key, value] of Object.entries(values)) {
				if (!same(part.get(key), from[name]?.[key])) skipped++;
				else steps.push([part, key, value]);
			}
		}
		if (steps.length === 0) {
			return {
				error: `Nothing to put back for “${describe(entry, parts)}”: it has changed since`,
			};
		}
		const ordered = [
			...steps.filter(([part]) => part.remote),
			...steps.filter(([part]) => !part.remote),
		];
		for (const [part, key, value] of ordered) {
			const refused = await actors.run(null, () => part.write(key, value));
			if (refused) return { error: refused };
		}
		return { skipped };
	};

	const step = (
		from: Entry[],
		to: Entry[],
		backward: boolean,
	): Promise<UndoOutcome> => {
		const run = async (): Promise<UndoOutcome> => {
			const entry = from.pop();
			if (!entry) {
				return {
					ok: false,
					error: backward ? "Nothing to undo" : "Nothing to redo",
				};
			}
			const result = backward
				? await apply(entry, entry.after, entry.before)
				: await apply(entry, entry.before, entry.after);
			const label = describe(entry, parts);
			if ("error" in result) {
				if (!result.error.startsWith("Nothing to put back")) from.push(entry);
				return { ok: false, error: result.error };
			}
			to.push(entry);
			return { ok: true, label, skipped: result.skipped };
		};
		const next = queue.then(run, run);
		queue = next;
		return next;
	};

	function track<S extends object>(
		part: string,
		store: S,
		methods: (keyof S)[],
	): S {
		const reader = parts[part];
		if (!reader) throw new Error(`No undo part ${part}`);
		const wrapped: Record<keyof S, unknown> = { ...store };
		for (const method of methods) {
			const original = store[method];
			if (typeof original !== "function") continue;
			wrapped[method] = (...args: unknown[]) => {
				if (!actors.getStore()) return original(...args);
				const before = reader.read();
				const result = original(...args);
				const [was, now] = diff(before, reader.read());
				recordMany(part, was, now);
				return result;
			};
		}
		return wrapped as S;
	}

	return {
		as: (actor, run) => actors.run(actor, run),
		track,
		note: (part, key, before, after) => record(part, before, after, key),
		undo: () => step(done, undone, true),
		redo: () => step(undone, done, false),
		peek: () => {
			const last = done.at(-1);
			const next = undone.at(-1);
			return {
				undo: last ? describe(last, parts) : null,
				redo: next ? describe(next, parts) : null,
			};
		},
	};
};

const byId = <T extends { id: string }>(list: readonly T[]) =>
	Object.fromEntries(list.map((item) => [item.id, item]));

/** The board's own things, as undo parts over their stores. */
export const boardParts = (stores: {
	layout: LayoutStore;
	annotations: AnnotationStore;
	regions: RegionStore;
	colours: ColourStore;
	relations: RelationStore;
	cloud?: {
		record(id: string): CloudRecord | null;
		restore(
			record: CloudRecord,
		): Promise<{ ok: true } | { ok: false; error: string }>;
		archive(id: string): Promise<{ ok: true } | { ok: false; error: string }>;
	};
}): Record<string, Part> => {
	const { layout, annotations, regions, colours, relations, cloud } = stores;
	const parts: Record<string, Part> = {
		layout: {
			read: () => layout.current(),
			get: (key) => layout.current()[key] ?? null,
			write: (key, value) => {
				layout.restore(key, (value as Placement | null) ?? null);
				return null;
			},
			noun: ["card", "cards"],
			verbs: { added: "move", removed: "move", changed: "move" },
		},
		annotations: {
			read: () => annotations.current(),
			get: (key) => annotations.current()[key] ?? null,
			write: (key, value) => {
				if (value === null) {
					annotations.remove(key);
					return null;
				}
				const put = annotations.put(value as Annotation);
				return "error" in put ? put.error : null;
			},
			noun: ["note", "notes"],
			verbs: { added: "add", removed: "delete", changed: "edit" },
		},
		regions: {
			read: () => byId(regions.current()),
			get: (key) => byId(regions.current())[key] ?? null,
			write: (key, value) => {
				if (value === null) regions.remove(key);
				else regions.restore(value as Region);
				return null;
			},
			noun: ["region", "regions"],
			verbs: { added: "draw", removed: "delete", changed: "change" },
		},
		colours: {
			read: () => colours.current(),
			get: (key) => colours.current()[key] ?? null,
			write: (key, value) =>
				colours.set({ cwd: key, colour: (value as never) ?? null })
					? null
					: "The board holds no more project colours",
			noun: ["project colour", "project colours"],
			verbs: { added: "change", removed: "change", changed: "change" },
		},
		relations: {
			read: () => byId(relations.current()),
			get: (key) => byId(relations.current())[key] ?? null,
			write: (key, value) => {
				if (value === null) relations.remove(key);
				else relations.restore(value as Relation);
				return null;
			},
			noun: ["link", "links"],
			verbs: { added: "link", removed: "unlink", changed: "change" },
		},
	};
	if (cloud) {
		parts.cloud = {
			read: () => ({}),
			get: (key) => cloud.record(key),
			write: async (key, value) => {
				const done = value
					? await cloud.restore(value as CloudRecord)
					: await cloud.archive(key);
				return done.ok ? null : done.error;
			},
			noun: ["cloud session", "cloud sessions"],
			remote: true,
			verbs: { added: "restore", removed: "exit", changed: "change" },
			name: (value) => {
				const name = (value as CloudRecord | null)?.name;
				return name ? `“${name}”` : null;
			},
		};
	}
	return parts;
};
