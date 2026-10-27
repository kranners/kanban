import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { RegionColours } from "../shared/colours.ts";
import {
	createColourStore,
	loadColours,
	parseColours,
	parseColourUpdate,
} from "./colours.ts";

describe("parseColourUpdate", () => {
	it("accepts a palette colour or null for an absolute cwd", () => {
		assert.deepEqual(
			parseColourUpdate({ cwd: "/Users/me/dev/acme-api", colour: "teal" }),
			{ cwd: "/Users/me/dev/acme-api", colour: "teal" },
		);
		assert.deepEqual(
			parseColourUpdate({ cwd: "/Users/me/dev/acme-api", colour: null }),
			{ cwd: "/Users/me/dev/acme-api", colour: null },
		);
	});

	it("rejects bad cwds and colours", () => {
		const cases: unknown[] = [
			null,
			[],
			{ colour: "teal" },
			{ cwd: "relative/path", colour: "teal" },
			{ cwd: "/a\0b", colour: "teal" },
			{ cwd: `/${"x".repeat(5000)}`, colour: "teal" },
			{ cwd: "/a", colour: "#ff0000" },
			{ cwd: "/a" },
		];
		for (const body of cases) {
			assert.ok("error" in parseColourUpdate(body), JSON.stringify(body));
		}
	});

	it("drops invalid entries from stored colours", () => {
		assert.deepEqual(
			parseColours({ "/a": "blue", "/b": "plaid", relative: "red" }),
			{ "/a": "blue" },
		);
		assert.deepEqual(parseColours("nope"), {});
	});
});

describe("createColourStore", () => {
	const setup = async (initial: RegionColours = {}) => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-colours-"));
		const file = join(dir, "state", "colours.json");
		const changes: RegionColours[] = [];
		const store = createColourStore({
			file,
			initial,
			onChange: (colours) => changes.push(colours),
		});
		return { dir, file, store, changes };
	};

	it("persists colours atomically and reloads them", async () => {
		const { dir, file, store, changes } = await setup();
		store.set({ cwd: "/dev/acme-api", colour: "red" });
		store.set({ cwd: "/dev/acme-api", colour: "violet" });
		store.set({ cwd: "/dev/acme-web", colour: "green" });
		await store.saved();
		assert.deepEqual(changes.at(-1), {
			"/dev/acme-api": "violet",
			"/dev/acme-web": "green",
		});
		assert.deepEqual(await loadColours(file), changes.at(-1));
		assert.deepEqual(await readdir(join(dir, "state")), ["colours.json"]);
	});

	it("returns a region to its default when cleared", async () => {
		const { file, store } = await setup({ "/dev/acme-api": "red" });
		store.set({ cwd: "/dev/acme-api", colour: null });
		await store.saved();
		assert.deepEqual(store.current(), {});
		assert.deepEqual(await loadColours(file), {});
	});

	it("treats a missing or corrupt file as no colours", async () => {
		const { dir, file } = await setup();
		assert.deepEqual(await loadColours(file), {});
		await writeFile(join(dir, "corrupt.json"), "{nope");
		assert.deepEqual(await loadColours(join(dir, "corrupt.json")), {});
	});
});
