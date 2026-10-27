import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Board, Layout, Session } from "../shared/types.ts";
import {
	createLayoutStore,
	loadLayout,
	parseLayout,
	parseLayoutUpdate,
	pruneAfterMs,
} from "./layout.ts";

const session = (id: string, short: string | null): Session => ({
	id,
	short,
	pid: null,
	name: id,
	cwd: "/Users/me/dev/acme-api",
	project: "acme-api",
	kind: "background",
	activity: "idle",
	doing: null,
	needs: null,
	startedAt: 0,
	updatedAt: 0,
	attachable: true,
	cmux: false,
});

const boardOf = (...sessions: Session[]): Board => ({
	sessions,
	subagents: [],
	subagentCounts: {},
	links: [],
	messages: [],
	generatedAt: 0,
});

describe("parseLayoutUpdate", () => {
	it("accepts a point or a sized placement for a node key", () => {
		assert.deepEqual(
			parseLayoutUpdate({ key: "session:abc-1", placement: { x: 1, y: 2 } }),
			{ key: "session:abc-1", placement: { x: 1, y: 2 } },
		);
		assert.deepEqual(
			parseLayoutUpdate({
				key: "subagent:agent_1",
				placement: { x: 1, y: 2, w: 300, h: 200, extra: true },
			}),
			{ key: "subagent:agent_1", placement: { x: 1, y: 2, w: 300, h: 200 } },
		);
		assert.deepEqual(
			parseLayoutUpdate({
				key: "session:abc-1",
				placement: { x: 1, y: 2, pinned: true },
			}),
			{ key: "session:abc-1", placement: { x: 1, y: 2, pinned: true } },
		);
		assert.deepEqual(
			parseLayoutUpdate({
				key: "session:abc-1",
				placement: { x: 1, y: 2, pinned: "yes" },
			}),
			{ key: "session:abc-1", placement: { x: 1, y: 2 } },
		);
	});

	it("rejects bad keys and placements", () => {
		const cases: unknown[] = [
			null,
			{ key: "card:1", placement: { x: 0, y: 0 } },
			{ key: "session:../x", placement: { x: 0, y: 0 } },
			{ key: "session:1", placement: { x: 0 } },
			{ key: "session:1", placement: { x: Number.POSITIVE_INFINITY, y: 0 } },
			{ key: "session:1", placement: { x: 0, y: 0, w: 10 } },
			{ key: "session:1", placement: { x: 0, y: 0, w: -1, h: 10 } },
			{ key: "session:1", placement: { x: 1e12, y: 0 } },
		];
		for (const body of cases) {
			assert.ok("error" in parseLayoutUpdate(body), JSON.stringify(body));
		}
	});

	it("drops invalid entries from a stored layout", () => {
		assert.deepEqual(
			parseLayout({
				"session:a": { x: 1, y: 2 },
				"session:b": { x: "1", y: 2 },
				nope: { x: 1, y: 2 },
			}),
			{ "session:a": { x: 1, y: 2 } },
		);
		assert.deepEqual(parseLayout([1, 2]), {});
	});
});

describe("createLayoutStore", () => {
	const setup = async (initial: Layout = {}) => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-layout-"));
		const file = join(dir, "state", "layout.json");
		const changes: Layout[] = [];
		let time = 1_000;
		const store = createLayoutStore({
			file,
			initial,
			onChange: (layout) => changes.push(layout),
			now: () => time,
		});
		return {
			dir,
			file,
			store,
			changes,
			advance: (ms: number) => {
				time += ms;
			},
		};
	};

	it("persists placements atomically and reloads them", async () => {
		const { dir, file, store, changes } = await setup();
		store.set({ key: "session:a", placement: { x: 10, y: 20 } });
		store.set({ key: "session:a", placement: { x: 30, y: 40, w: 5, h: 6 } });
		await store.saved();
		assert.deepEqual(changes.at(-1), {
			"session:a": { x: 30, y: 40, w: 5, h: 6 },
		});
		assert.deepEqual(await loadLayout(file), changes.at(-1));
		assert.deepEqual(await readdir(join(dir, "state")), ["layout.json"]);
	});

	it("treats a missing or corrupt file as an empty layout", async () => {
		const { dir, file } = await setup();
		assert.deepEqual(await loadLayout(file), {});
		await writeFile(join(dir, "corrupt.json"), "{nope");
		assert.deepEqual(await loadLayout(join(dir, "corrupt.json")), {});
	});

	it("places a spawned session where its prompt was opened", async () => {
		const { store, changes, file } = await setup();
		store.expect("feedbeef", { x: 96, y: 144 });
		store.observe(boardOf(session("other", "0000aaaa")));
		assert.equal(changes.length, 0);
		store.observe(boardOf(session("new-one", "feedbeef")));
		assert.deepEqual(store.current(), { "session:new-one": { x: 96, y: 144 } });
		store.observe(boardOf(session("new-one", "feedbeef")));
		assert.equal(changes.length, 1);
		await store.saved();
		assert.match(await readFile(file, "utf8"), /new-one/);
	});

	it("forgets a spawn that never appears", async () => {
		const { store, advance } = await setup();
		store.expect("feedbeef", { x: 1, y: 1 });
		advance(11 * 60_000);
		store.observe(boardOf());
		store.observe(boardOf(session("late", "feedbeef")));
		assert.deepEqual(store.current(), {});
	});

	it("prunes placements whose node has been gone for a while", async () => {
		const { store, advance } = await setup({
			"session:gone": { x: 0, y: 0 },
			"session:back": { x: 1, y: 1 },
			"session:here": { x: 2, y: 2 },
		});
		store.observe(boardOf(session("here", null)));
		advance(pruneAfterMs / 2);
		store.observe(boardOf(session("here", null), session("back", null)));
		advance(pruneAfterMs / 2 + 1);
		store.observe(boardOf(session("here", null)));
		assert.deepEqual(Object.keys(store.current()).sort(), [
			"session:back",
			"session:here",
		]);
	});
});
