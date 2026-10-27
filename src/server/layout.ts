import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
	Board,
	Layout,
	LayoutUpdate,
	Placement,
	Point,
} from "../shared/types.ts";

export type LayoutStore = {
	current(): Layout;
	set(update: LayoutUpdate): void;
	expect(short: string, at: Point): void;
	observe(board: Board): void;
	saved(): Promise<void>;
};

export type LayoutStoreOptions = {
	file: string;
	initial: Layout;
	onChange: (layout: Layout) => void;
	now?: () => number;
};

const nodeKeyPattern = /^(session|subagent):[A-Za-z0-9_-]{1,128}$/;
const maxCoordinate = 10_000_000;
const maxSize = 100_000;
const pendingSpawnMs = 10 * 60_000;
export const pruneAfterMs = 24 * 60 * 60_000;

export const isCoordinate = (value: unknown): value is number =>
	typeof value === "number" &&
	Number.isFinite(value) &&
	Math.abs(value) <= maxCoordinate;

const isSize = (value: unknown): value is number =>
	typeof value === "number" &&
	Number.isFinite(value) &&
	value > 0 &&
	value <= maxSize;

export const parsePoint = (value: unknown): Point | null => {
	if (typeof value !== "object" || value === null) return null;
	const { x, y } = value as Record<string, unknown>;
	return isCoordinate(x) && isCoordinate(y) ? { x, y } : null;
};

export const parsePlacement = (value: unknown): Placement | null => {
	const point = parsePoint(value);
	if (!point) return null;
	const { w, h } = value as Record<string, unknown>;
	if (w === undefined && h === undefined) return point;
	return isSize(w) && isSize(h) ? { ...point, w, h } : null;
};

export const parseLayoutUpdate = (
	body: unknown,
): LayoutUpdate | { error: string } => {
	if (typeof body !== "object" || body === null) {
		return { error: "Expected a JSON object with key and placement" };
	}
	const { key, placement } = body as Record<string, unknown>;
	if (typeof key !== "string" || !nodeKeyPattern.test(key)) {
		return { error: "key must be session:<id> or subagent:<id>" };
	}
	const parsed = parsePlacement(placement);
	if (!parsed) {
		return {
			error: "placement needs finite x and y, and w and h together if sized",
		};
	}
	return { key, placement: parsed };
};

export const parseLayout = (value: unknown): Layout => {
	if (typeof value !== "object" || value === null) return {};
	const layout: Layout = {};
	for (const [key, raw] of Object.entries(value)) {
		const placement = parsePlacement(raw);
		if (nodeKeyPattern.test(key) && placement) layout[key] = placement;
	}
	return layout;
};

export const boardKeys = (board: Board): Set<string> =>
	new Set([
		...board.sessions.map((session) => `session:${session.id}`),
		...board.subagents.map((subagent) => `subagent:${subagent.id}`),
	]);

export const loadLayout = async (file: string): Promise<Layout> => {
	try {
		return parseLayout(JSON.parse(await readFile(file, "utf8")));
	} catch {
		return {};
	}
};

export const writeAtomically = async (file: string, text: string) => {
	await mkdir(dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, text);
	await rename(temporary, file);
};

export const createLayoutStore = ({
	file,
	initial,
	onChange,
	now = Date.now,
}: LayoutStoreOptions): LayoutStore => {
	let layout: Layout = { ...initial };
	const pending = new Map<string, { at: Point; since: number }>();
	const missingSince = new Map<string, number>();
	let writing: Promise<void> = Promise.resolve();
	let dirty = false;

	const persist = () => {
		if (dirty) return;
		dirty = true;
		writing = writing
			.then(() => {
				dirty = false;
				return writeAtomically(file, `${JSON.stringify(layout)}\n`);
			})
			.catch((error: unknown) => console.error("layout write failed", error));
	};

	const commit = (next: Layout) => {
		layout = next;
		persist();
		onChange(layout);
	};

	return {
		current: () => layout,
		set({ key, placement }) {
			missingSince.delete(key);
			commit({ ...layout, [key]: placement });
		},
		expect(short, at) {
			pending.set(short, { at, since: now() });
		},
		observe(board) {
			const time = now();
			const next = { ...layout };
			let changed = false;
			for (const [short, spawn] of pending) {
				const session = board.sessions.find((s) => s.short === short);
				if (session) {
					next[`session:${session.id}`] = spawn.at;
					missingSince.delete(`session:${session.id}`);
					pending.delete(short);
					changed = true;
				} else if (time - spawn.since > pendingSpawnMs) {
					pending.delete(short);
				}
			}
			const live = boardKeys(board);
			for (const key of Object.keys(next)) {
				if (live.has(key)) {
					missingSince.delete(key);
					continue;
				}
				const since = missingSince.get(key) ?? time;
				missingSince.set(key, since);
				if (time - since > pruneAfterMs) {
					delete next[key];
					missingSince.delete(key);
					changed = true;
				}
			}
			if (changed) commit(next);
		},
		saved: () => writing,
	};
};
