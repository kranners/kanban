import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Region } from "../shared/types.ts";
import {
	createRegionStore,
	loadRegions,
	maxRegions,
	parseRegionDraft,
	parseRegionPatch,
	parseRegions,
} from "./regions.ts";

const bounds = { x: 0, y: 24, w: 480, h: 336 };

describe("parseRegionDraft", () => {
	it("accepts an existing absolute directory with bounds and a name", async () => {
		const cwd = tmpdir();
		assert.deepEqual(await parseRegionDraft({ cwd, ...bounds, extra: 1 }), {
			cwd,
			...bounds,
		});
		assert.deepEqual(
			await parseRegionDraft({ cwd, ...bounds, name: "  Acme  " }),
			{ cwd, ...bounds, name: "Acme" },
		);
	});

	it("rejects bad directories, names and bounds", async () => {
		const cwd = tmpdir();
		const cases: unknown[] = [
			null,
			[],
			{ ...bounds },
			{ cwd: "relative/dir", ...bounds },
			{ cwd: "/definitely/not/here", ...bounds },
			{ cwd: join(cwd, "kanban-missing-region-dir"), ...bounds },
			{ cwd, ...bounds, name: 5 },
			{ cwd, ...bounds, name: "x".repeat(61) },
			{ cwd, ...bounds, name: "two\nlines" },
			{ cwd, ...bounds, x: Number.NaN },
			{ cwd, ...bounds, y: 1e12 },
			{ cwd, ...bounds, w: 10 },
			{ cwd, ...bounds, h: 50_000 },
			{ cwd, x: 0, y: 0, w: 480 },
		];
		for (const body of cases) {
			assert.ok(
				"error" in (await parseRegionDraft(body)),
				JSON.stringify(body),
			);
		}
	});
});

describe("parseRegionPatch", () => {
	it("accepts a name, a cleared name, or full bounds", () => {
		assert.deepEqual(parseRegionPatch({ name: "Acme" }), { name: "Acme" });
		assert.deepEqual(parseRegionPatch({ name: " " }), { name: null });
		assert.deepEqual(parseRegionPatch({ name: null }), { name: null });
		assert.deepEqual(
			parseRegionPatch({ ...bounds, cwd: "/elsewhere" }),
			bounds,
		);
	});

	it("rejects partial bounds, bad names and empty patches", () => {
		const cases: unknown[] = [
			null,
			{},
			{ cwd: "/elsewhere" },
			{ x: 1, y: 2 },
			{ ...bounds, w: 0 },
			{ ...bounds, h: Number.POSITIVE_INFINITY },
			{ name: 1 },
		];
		for (const body of cases) {
			assert.ok("error" in parseRegionPatch(body), JSON.stringify(body));
		}
	});
});

describe("parseRegions", () => {
	it("drops invalid and duplicate entries and caps the count", () => {
		const good: Region = {
			id: "a",
			cwd: "/dev/acme-api",
			name: null,
			...bounds,
		};
		assert.deepEqual(
			parseRegions([
				good,
				{ ...good, name: "dup" },
				{ ...good, id: "../b" },
				{ ...good, id: "c", cwd: "dev/acme-api" },
				{ ...good, id: "d", w: -1 },
				"nope",
			]),
			[good],
		);
		assert.deepEqual(parseRegions({ a: good }), []);
		const many = Array.from({ length: maxRegions + 5 }, (_, i) => ({
			...good,
			id: `r${i}`,
		}));
		assert.equal(parseRegions(many).length, maxRegions);
	});
});

describe("createRegionStore", () => {
	const setup = async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-regions-"));
		const file = join(dir, "state", "regions.json");
		const changes: Region[][] = [];
		let next = 0;
		const store = createRegionStore({
			file,
			initial: [],
			onChange: (regions) => changes.push(regions),
			newId: () => `region-${++next}`,
		});
		return { dir, file, store, changes };
	};

	it("creates, updates and removes regions, persisting atomically", async () => {
		const { dir, file, store, changes } = await setup();
		const made = store.create({ cwd: "/dev/acme-api", ...bounds });
		assert.deepEqual(made, {
			id: "region-1",
			name: null,
			cwd: "/dev/acme-api",
			...bounds,
		});
		assert.equal(store.update("region-1", { name: "Acme" })?.name, "Acme");
		assert.equal(store.update("missing", { name: "x" }), null);
		store.create({ cwd: "/dev/acme-web", ...bounds });
		assert.equal(store.remove("region-1"), true);
		assert.equal(store.remove("region-1"), false);
		await store.saved();
		assert.equal(changes.length, 4);
		assert.deepEqual(await loadRegions(file), store.current());
		assert.deepEqual(
			store.current().map((r) => r.id),
			["region-2"],
		);
		assert.deepEqual(await readdir(join(dir, "state")), ["regions.json"]);
	});

	it("refuses to grow past the cap", async () => {
		const { store } = await setup();
		for (let i = 0; i < maxRegions; i++)
			assert.ok(store.create({ cwd: "/dev/acme-api", ...bounds }));
		assert.equal(store.create({ cwd: "/dev/acme-api", ...bounds }), null);
	});

	it("treats a missing or corrupt file as no regions", async () => {
		const { dir, file } = await setup();
		assert.deepEqual(await loadRegions(file), []);
		await writeFile(join(dir, "corrupt.json"), "[nope");
		assert.deepEqual(await loadRegions(join(dir, "corrupt.json")), []);
	});
});
