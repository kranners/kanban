import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { DocStore } from "../shared/types.ts";
import { loadAnnotations } from "./annotations.ts";
import {
	createDocStoreRegistry,
	docStoresFileName,
	loadDocStores,
	migrateDocStoreFiles,
	migrateDocStores,
	parseDocStores,
	parseDocTitle,
	untitledDocs,
} from "./docStores.ts";
import { loadRelations } from "./relations.ts";

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const c = "33333333-3333-4333-8333-333333333333";

const store = (id: string, title: string, at = 1): DocStore => ({
	id,
	title,
	createdAt: at,
	updatedAt: at,
});

const registryAt = async (initial: DocStore[] = []) => {
	const dir = await mkdtemp(join(tmpdir(), "kanban-doc-stores-"));
	const file = join(dir, docStoresFileName);
	const dropped: string[] = [];
	const changes: DocStore[][] = [];
	const clock = { now: 10 };
	let ids = 0;
	const registry = createDocStoreRegistry({
		file,
		initial,
		files: {
			drop: async (id) => {
				dropped.push(id);
			},
		},
		onChange: (next) => changes.push(next),
		newId: () => [a, b, c][ids++] ?? "x",
		now: () => clock.now,
	});
	return { registry, file, dropped, changes, clock };
};

describe("parseDocTitle", () => {
	it("trims a one-line title of up to 60 characters", () => {
		assert.equal(parseDocTitle("  API guide "), "API guide");
		for (const bad of [undefined, 3, "", "  ", "a\nb", "x".repeat(61)]) {
			assert.ok(typeof parseDocTitle(bad) !== "string", JSON.stringify(bad));
		}
	});
});

describe("parseDocStores", () => {
	it("keeps valid, distinct stores sorted by title, ignoring case", () => {
		assert.deepEqual(
			parseDocStores([
				store(a, "runbook"),
				store(b, "API guide"),
				store(a, "again"),
				{ id: "../x", title: "Bad", createdAt: 1, updatedAt: 1 },
				{ id: c, title: "No times" },
				null,
			]),
			[store(b, "API guide"), store(a, "runbook")],
		);
		assert.deepEqual(parseDocStores({}), []);
	});
});

describe("createDocStoreRegistry", () => {
	it("creates, renames, touches and removes stores and persists them", async () => {
		const { registry, file, dropped, changes, clock } = await registryAt();
		const made = registry.create(" Runbook ");
		assert.deepEqual(made, store(a, "Runbook", 10));
		assert.deepEqual(registry.create("a\nb"), {
			error: "title must be 1 to 60 characters on one line",
		});
		registry.create("API guide");
		assert.deepEqual(
			registry.current().map((s) => s.title),
			["API guide", "Runbook"],
		);
		clock.now = 20;
		assert.deepEqual(registry.rename(a, "Zed"), {
			...store(a, "Zed", 10),
			updatedAt: 20,
		});
		assert.equal(registry.rename("nope", "Zed"), null);
		assert.ok("error" in (registry.rename(a, "") ?? {}));
		clock.now = 30;
		registry.touch(b);
		assert.equal(registry.get(b)?.updatedAt, 30);
		registry.touch("nope");
		assert.equal(await registry.remove(a), true);
		assert.equal(await registry.remove(a), false);
		assert.deepEqual(dropped, [a]);
		assert.equal(changes.length, 5);
		await registry.saved();
		assert.deepEqual(await loadDocStores(file), [
			{ ...store(b, "API guide", 10), updatedAt: 30 },
		]);
	});
});

describe("migrateDocStores", () => {
	const docsAnnotation = (title: unknown) => ({
		kind: "docs",
		title,
		x: 0,
		y: 0,
		w: 288,
		h: 216,
		z: 1,
	});
	const note = {
		kind: "note",
		text: "hi",
		color: "yellow",
		x: 0,
		y: 0,
		w: 200,
		h: 160,
		z: 2,
	};
	const session = (id: string) => ({ kind: "session", id });

	it("moves doc annotations into the registry and drops their links", () => {
		const migrated = migrateDocStores(
			{
				stores: [store(c, "Kept", 1)],
				annotations: {
					[a]: docsAnnotation("API guide"),
					[b]: docsAnnotation("a\nbroken"),
					[c]: docsAnnotation("Renamed on the board"),
					n1: note,
				},
				relations: [
					{ id: "r1", from: session("s1"), to: { kind: "docs", id: a } },
					{ id: "r2", from: session("s1"), to: session("s2") },
				],
				folders: [a, "orphan-1", ".hidden"],
			},
			5,
		);
		assert.deepEqual(migrated.stores, [
			store(a, "API guide", 5),
			store(c, "Kept", 1),
			store(b, untitledDocs, 5),
			store("orphan-1", untitledDocs, 5),
		]);
		assert.deepEqual(migrated.annotations, { n1: note });
		assert.deepEqual(migrated.relations, [
			{ id: "r2", from: session("s1"), to: session("s2") },
		]);
		assert.deepEqual(migrated.changed, {
			stores: true,
			annotations: true,
			relations: true,
		});
	});

	it("changes nothing when run again", () => {
		const migrated = migrateDocStores(
			{
				stores: [store(a, "API guide")],
				annotations: { n1: note },
				relations: [],
				folders: [a],
			},
			5,
		);
		assert.deepEqual(migrated.changed, {
			stores: false,
			annotations: false,
			relations: false,
		});
	});
});

describe("migrateDocStoreFiles", () => {
	it("migrates the state directory without losing a store, idempotently", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "kanban-migrate-"));
		const annotationsFile = join(stateDir, "annotations.json");
		const relationsFile = join(stateDir, "relations.json");
		await writeFile(
			annotationsFile,
			JSON.stringify({
				[a]: {
					kind: "docs",
					title: "API guide",
					x: 0,
					y: 0,
					w: 288,
					h: 216,
					z: 1,
				},
				n1: {
					kind: "note",
					text: "hi",
					color: "yellow",
					x: 0,
					y: 0,
					w: 200,
					h: 160,
					z: 2,
				},
			}),
		);
		await writeFile(
			relationsFile,
			JSON.stringify([
				{
					id: "r1",
					from: { kind: "session", id: "s1" },
					to: { kind: "docs", id: a },
					createdAt: 1,
				},
				{
					id: "r2",
					from: { kind: "session", id: "s1" },
					to: { kind: "session", id: "s2" },
					createdAt: 1,
				},
			]),
		);
		await mkdir(join(stateDir, "docs", b, "guides"), { recursive: true });
		await writeFile(join(stateDir, "docs", b, "guides", "x.md"), "# X");
		await mkdir(join(stateDir, "docs", c), { recursive: true });

		const first = await migrateDocStoreFiles(
			{ stateDir, annotationsFile, relationsFile },
			7,
		);
		assert.deepEqual(first, [
			store(a, "API guide", 7),
			store(b, untitledDocs, 7),
		]);
		assert.deepEqual(
			await loadDocStores(join(stateDir, docStoresFileName)),
			first,
		);
		assert.deepEqual(Object.keys(await loadAnnotations(annotationsFile)), [
			"n1",
		]);
		assert.ok(
			!(await readFile(annotationsFile, "utf8")).includes('"docs"'),
			"the doc annotation is gone from the file",
		);
		assert.deepEqual(
			(await loadRelations(relationsFile)).map((relation) => relation.id),
			["r2"],
		);
		const again = await migrateDocStoreFiles(
			{ stateDir, annotationsFile, relationsFile },
			99,
		);
		assert.deepEqual(again, first);
	});

	it("leaves the annotations alone when the registry can't be written", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "kanban-migrate-"));
		const annotationsFile = join(stateDir, "annotations.json");
		const original = JSON.stringify({
			[a]: {
				kind: "docs",
				title: "API guide",
				x: 0,
				y: 0,
				w: 288,
				h: 216,
				z: 1,
			},
		});
		await writeFile(annotationsFile, original);
		// A directory where the registry file belongs makes its rename fail.
		await mkdir(join(stateDir, docStoresFileName, "blocker"), {
			recursive: true,
		});
		await assert.rejects(
			migrateDocStoreFiles({
				stateDir,
				annotationsFile,
				relationsFile: join(stateDir, "relations.json"),
			}),
		);
		assert.equal(await readFile(annotationsFile, "utf8"), original);
	});

	it("starts empty on a fresh state directory", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "kanban-migrate-"));
		assert.deepEqual(
			await migrateDocStoreFiles({
				stateDir,
				annotationsFile: join(stateDir, "annotations.json"),
				relationsFile: join(stateDir, "relations.json"),
			}),
			[],
		);
	});
});
