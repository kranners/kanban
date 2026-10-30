import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ProjectIgnores } from "../shared/ignores.ts";
import {
	createIgnoreStore,
	loadIgnores,
	longestIgnoreMs,
	maxIgnores,
	parseIgnores,
	parseIgnoreUpdate,
} from "./ignores.ts";

const now = 1_000_000;
const hour = 60 * 60 * 1000;

describe("parseIgnoreUpdate", () => {
	it("accepts a time or null for an absolute cwd", () => {
		assert.deepEqual(
			parseIgnoreUpdate({ cwd: "/dev/acme-api", until: now + hour }, now),
			{ cwd: "/dev/acme-api", until: now + hour },
		);
		assert.deepEqual(
			parseIgnoreUpdate({ cwd: "/dev/acme-api", until: null }, now),
			{ cwd: "/dev/acme-api", until: null },
		);
	});

	it("rejects bad cwds, times and ignores longer than a month", () => {
		const cases: unknown[] = [
			null,
			[],
			{ until: now + hour },
			{ cwd: "relative/path", until: now + hour },
			{ cwd: "/a\0b", until: now + hour },
			{ cwd: "/a", until: "tomorrow" },
			{ cwd: "/a", until: 1.5 },
			{ cwd: "/a", until: -1 },
			{ cwd: "/a" },
			{ cwd: "/a", until: now + longestIgnoreMs + 1 },
		];
		for (const body of cases) {
			assert.ok("error" in parseIgnoreUpdate(body, now), JSON.stringify(body));
		}
	});

	it("drops invalid entries from stored ignores", () => {
		assert.deepEqual(parseIgnores({ "/a": now, "/b": "soon", relative: now }), {
			"/a": now,
		});
		assert.deepEqual(parseIgnores("nope"), {});
	});
});

describe("createIgnoreStore", () => {
	const setup = async (initial: ProjectIgnores = {}) => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-ignores-"));
		const file = join(dir, "state", "ignores.json");
		const changes: ProjectIgnores[] = [];
		let at = now;
		const store = createIgnoreStore({
			file,
			initial,
			now: () => at,
			onChange: (ignores) => changes.push(ignores),
		});
		const advance = (ms: number) => {
			at += ms;
		};
		return { dir, file, store, changes, advance };
	};

	it("persists ignores and reloads them", async () => {
		const { dir, file, store, changes } = await setup();
		store.set({ cwd: "/dev/acme-api", until: now + hour });
		store.set({ cwd: "/dev/acme-web", until: now + 2 * hour });
		await store.saved();
		assert.deepEqual(changes.at(-1), {
			"/dev/acme-api": now + hour,
			"/dev/acme-web": now + 2 * hour,
		});
		assert.deepEqual(await loadIgnores(file), changes.at(-1));
		assert.deepEqual(await readdir(join(dir, "state")), ["ignores.json"]);
	});

	it("stops ignoring when cleared or given a past time", async () => {
		const { store } = await setup({
			"/dev/acme-api": now + hour,
			"/dev/acme-web": now + hour,
		});
		store.set({ cwd: "/dev/acme-api", until: null });
		store.set({ cwd: "/dev/acme-web", until: now - 1 });
		assert.deepEqual(store.current(), {});
	});

	it("forgets ignores that have run out", async () => {
		const { store, advance } = await setup({
			"/dev/old": now - 1,
			"/dev/acme-api": now + hour,
		});
		assert.deepEqual(store.current(), { "/dev/acme-api": now + hour });
		advance(2 * hour);
		store.set({ cwd: "/dev/acme-web", until: now + 3 * hour });
		assert.deepEqual(store.current(), { "/dev/acme-web": now + 3 * hour });
	});

	it("refuses new cwds once full but still clears", async () => {
		const full = Object.fromEntries(
			Array.from({ length: maxIgnores }, (_, i) => [`/dev/p${i}`, now + hour]),
		);
		const { store } = await setup(full);
		assert.equal(store.set({ cwd: "/dev/new", until: now + hour }), false);
		assert.equal(store.set({ cwd: "/dev/p0", until: now + 2 * hour }), true);
		assert.equal(store.set({ cwd: "/dev/p1", until: null }), true);
		assert.equal(store.set({ cwd: "/dev/new", until: now + hour }), true);
		assert.equal(Object.keys(store.current()).length, maxIgnores);
	});

	it("treats a missing or corrupt file as no ignores", async () => {
		const { dir, file } = await setup();
		assert.deepEqual(await loadIgnores(file), {});
		await writeFile(join(dir, "corrupt.json"), "{nope");
		assert.deepEqual(await loadIgnores(join(dir, "corrupt.json")), {});
	});
});
