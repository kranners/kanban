import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Note, Region } from "../shared/types.ts";
import { createAnnotationStore } from "./annotations.ts";
import type { CloudRecord } from "./cloud.ts";
import { createColourStore } from "./colours.ts";
import { createLayoutStore } from "./layout.ts";
import { createRegionStore } from "./regions.ts";
import { createRelationStore } from "./relations.ts";
import { boardParts, butlerGapMs, createUndo, yourGapMs } from "./undo.ts";

const note = (id: string, text = "ship the acme-api fix"): Note => ({
	id,
	kind: "note",
	x: 10,
	y: -20,
	w: 192,
	h: 192,
	z: 1,
	text,
	color: "yellow",
});

const cloudRecord: CloudRecord = {
	id: "session_01Acme",
	cwd: "/Users/me/dev/acme-api",
	name: "Fix the acme login",
	createdAt: 1,
};

const fakeCloud = () => {
	const shown = new Map<string, CloudRecord>([[cloudRecord.id, cloudRecord]]);
	const calls: string[] = [];
	let refuse: string | null = null;
	return {
		calls,
		refuse: (error: string | null) => {
			refuse = error;
		},
		record: (id: string) => shown.get(id) ?? null,
		restore: async (record: CloudRecord) => {
			calls.push(`unarchive ${record.id}`);
			if (refuse) return { ok: false as const, error: refuse };
			shown.set(record.id, record);
			return { ok: true as const };
		},
		archive: async (id: string) => {
			calls.push(`archive ${id}`);
			shown.delete(id);
			return { ok: true as const };
		},
	};
};

const board = async (start = 0) => {
	const dir = await mkdtemp(join(tmpdir(), "kanban-undo-"));
	let time = start;
	const stores = {
		layout: createLayoutStore({
			file: join(dir, "layout.json"),
			initial: {},
			onChange: () => {},
		}),
		annotations: createAnnotationStore({
			file: join(dir, "annotations.json"),
			initial: {},
			onChange: () => {},
		}),
		regions: createRegionStore({
			file: join(dir, "regions.json"),
			initial: [],
			onChange: () => {},
			newId: () => "region-1",
		}),
		colours: createColourStore({
			file: join(dir, "colours.json"),
			initial: {},
			onChange: () => {},
		}),
		relations: createRelationStore({
			file: join(dir, "relations.json"),
			initial: [],
			onChange: () => {},
			newId: () => "link-1",
		}),
	};
	const cloud = fakeCloud();
	const undo = createUndo({
		parts: boardParts({ ...stores, cloud }),
		now: () => time,
	});
	const tracked = {
		layout: undo.track("layout", stores.layout, ["set", "setMany"]),
		annotations: undo.track("annotations", stores.annotations, [
			"put",
			"remove",
		]),
		regions: undo.track("regions", stores.regions, [
			"create",
			"update",
			"remove",
		]),
		relations: undo.track("relations", stores.relations, ["create", "remove"]),
	};
	return {
		stores,
		tracked,
		undo,
		cloud,
		later: (ms: number) => {
			time += ms;
		},
	};
};

describe("createUndo", () => {
	it("puts a moved card back and moves it again on redo", async () => {
		const { stores, tracked, undo, later } = await board();
		const key = "session:acme";
		stores.layout.set({ key, placement: { x: 0, y: 0, pinned: true } });
		undo.as("you", () =>
			tracked.layout.set({ key, placement: { x: 400, y: 80, pinned: true } }),
		);
		assert.equal(undo.peek().undo, "Move a card");
		later(yourGapMs * 2);
		assert.deepEqual(await undo.undo(), {
			ok: true,
			label: "Move a card",
			skipped: 0,
		});
		assert.deepEqual(stores.layout.current()[key], {
			x: 0,
			y: 0,
			pinned: true,
		});
		assert.equal(undo.peek().redo, "Move a card");
		await undo.redo();
		assert.deepEqual(stores.layout.current()[key], {
			x: 400,
			y: 80,
			pinned: true,
		});
	});

	it("forgets a card's spot when undoing its first placement", async () => {
		const { stores, tracked, undo } = await board();
		undo.as("you", () =>
			tracked.layout.set({ key: "session:acme", placement: { x: 1, y: 2 } }),
		);
		await undo.undo();
		assert.deepEqual(stores.layout.current(), {});
	});

	it("records nothing made outside an actor", async () => {
		const { tracked, undo } = await board();
		tracked.layout.set({ key: "session:acme", placement: { x: 1, y: 2 } });
		undo.as(null, () => tracked.annotations.put(note("note-1")));
		assert.deepEqual(undo.peek(), { undo: null, redo: null });
		assert.deepEqual(await undo.undo(), {
			ok: false,
			error: "Nothing to undo",
		});
	});

	it("brings a deleted note back, and takes away an added one", async () => {
		const { stores, tracked, undo, later } = await board();
		undo.as("you", () => tracked.annotations.put(note("note-1")));
		later(yourGapMs * 2);
		undo.as("you", () => tracked.annotations.remove("note-1"));
		assert.equal(undo.peek().undo, "Delete a note");
		await undo.undo();
		assert.equal(stores.annotations.current()["note-1"]?.kind, "note");
		assert.equal(undo.peek().undo, "Add a note");
		await undo.undo();
		assert.deepEqual(stores.annotations.current(), {});
	});

	it("takes a quick run of your changes as one step", async () => {
		const { stores, tracked, undo, later } = await board();
		undo.as("you", () => {
			tracked.annotations.put(note("note-1"));
			tracked.annotations.put(note("note-2"));
		});
		later(yourGapMs / 2);
		undo.as("you", () => tracked.annotations.put(note("note-3")));
		assert.equal(undo.peek().undo, "Add 3 notes");
		await undo.undo();
		assert.deepEqual(stores.annotations.current(), {});
	});

	it("takes all of one Butler request as one step, apart from yours", async () => {
		const { stores, tracked, undo, later } = await board();
		stores.layout.setMany([
			{ key: "session:a", placement: { x: 0, y: 0 } },
			{ key: "session:b", placement: { x: 0, y: 300 } },
		]);
		undo.as("you", () => tracked.annotations.put(note("note-1")));
		later(yourGapMs * 2);
		const butler = "butler:thread-1";
		undo.as(butler, () => {
			tracked.layout.setMany([
				{ key: "session:a", placement: { x: 500, y: 0, pinned: true } },
			]);
		});
		later(butlerGapMs / 2);
		undo.as(butler, () => {
			tracked.layout.setMany([
				{ key: "session:b", placement: { x: 500, y: 300, pinned: true } },
			]);
			tracked.regions.create({
				cwd: "/Users/me/dev/acme-api",
				x: 480,
				y: -20,
				w: 600,
				h: 700,
			});
		});
		assert.equal(undo.peek().undo, "Butler: Move 2 cards, draw a region");
		await undo.undo();
		assert.deepEqual(stores.layout.current(), {
			"session:a": { x: 0, y: 0 },
			"session:b": { x: 0, y: 300 },
		});
		assert.deepEqual(stores.regions.current(), []);
		assert.equal(undo.peek().undo, "Add a note");
	});

	it("restores a deleted region under its own id", async () => {
		const { stores, tracked, undo } = await board();
		const region: Region = {
			id: "region-9",
			cwd: "/Users/me/dev/acme-api",
			name: "acme",
			x: 0,
			y: 0,
			w: 400,
			h: 400,
		};
		stores.regions.restore(region);
		undo.as("you", () => tracked.regions.remove("region-9"));
		await undo.undo();
		assert.deepEqual(stores.regions.current(), [region]);
	});

	it("relinks an unlinked pair", async () => {
		const { stores, tracked, undo, later } = await board();
		const created = undo.as("you", () =>
			tracked.relations.create({
				from: { kind: "session", id: "a" },
				to: { kind: "session", id: "b" },
			}),
		);
		assert.ok(!("error" in created));
		later(yourGapMs * 2);
		undo.as("you", () => tracked.relations.remove(created.id));
		assert.equal(undo.peek().undo, "Unlink a link");
		await undo.undo();
		assert.deepEqual(stores.relations.current(), [created]);
	});

	it("leaves alone what changed since, and says so", async () => {
		const { stores, tracked, undo, later } = await board();
		undo.as("you", () => {
			tracked.layout.set({ key: "session:a", placement: { x: 9, y: 9 } });
			tracked.layout.set({ key: "session:b", placement: { x: 9, y: 9 } });
		});
		later(yourGapMs * 2);
		stores.layout.set({ key: "session:b", placement: { x: 50, y: 50 } });
		assert.deepEqual(await undo.undo(), {
			ok: true,
			label: "Move 2 cards",
			skipped: 1,
		});
		assert.deepEqual(stores.layout.current(), {
			"session:b": { x: 50, y: 50 },
		});
	});

	it("drops a step that has nothing left to put back", async () => {
		const { stores, tracked, undo } = await board();
		undo.as("you", () => tracked.annotations.put(note("note-1")));
		stores.annotations.remove("note-1");
		const outcome = await undo.undo();
		assert.equal(outcome.ok, false);
		assert.deepEqual(undo.peek(), { undo: null, redo: null });
	});

	it("clears redo once something new happens", async () => {
		const { tracked, undo, later } = await board();
		undo.as("you", () => tracked.annotations.put(note("note-1")));
		await undo.undo();
		later(yourGapMs * 2);
		undo.as("you", () => tracked.annotations.put(note("note-2")));
		assert.equal(undo.peek().redo, null);
		assert.deepEqual(await undo.redo(), {
			ok: false,
			error: "Nothing to redo",
		});
	});

	it("unarchives an exited cloud session, and keeps the step when claude.ai refuses", async () => {
		const { undo, cloud } = await board();
		await undo.as("you", async () => {
			const record = cloud.record(cloudRecord.id);
			await cloud.archive(cloudRecord.id);
			undo.note("cloud", cloudRecord.id, record, null);
		});
		assert.equal(undo.peek().undo, "Exit cloud session “Fix the acme login”");
		cloud.refuse(
			"Cloud API POST /v1/sessions/x/unarchive failed with HTTP 403",
		);
		const refused = await undo.undo();
		assert.equal(refused.ok, false);
		assert.equal(cloud.record(cloudRecord.id), null);
		assert.ok(undo.peek().undo);
		cloud.refuse(null);
		assert.deepEqual(await undo.undo(), {
			ok: true,
			label: "Exit cloud session “Fix the acme login”",
			skipped: 0,
		});
		assert.deepEqual(cloud.record(cloudRecord.id), cloudRecord);
		await undo.redo();
		assert.equal(cloud.record(cloudRecord.id), null);
		assert.deepEqual(cloud.calls, [
			`archive ${cloudRecord.id}`,
			`unarchive ${cloudRecord.id}`,
			`unarchive ${cloudRecord.id}`,
			`archive ${cloudRecord.id}`,
		]);
	});

	it("keeps at most its limit of steps", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-undo-"));
		const annotations = createAnnotationStore({
			file: join(dir, "annotations.json"),
			initial: {},
			onChange: () => {},
		});
		let time = 0;
		const undo = createUndo({
			parts: {
				annotations: boardParts({
					...(await board()).stores,
					annotations,
				}).annotations as never,
			},
			now: () => time,
			limit: 2,
		});
		const tracked = undo.track("annotations", annotations, ["put"]);
		for (const id of ["a", "b", "c"]) {
			time += yourGapMs * 2;
			undo.as("you", () => tracked.put(note(id)));
		}
		await undo.undo();
		await undo.undo();
		assert.deepEqual(await undo.undo(), {
			ok: false,
			error: "Nothing to undo",
		});
		assert.deepEqual(Object.keys(annotations.current()), ["a"]);
	});
});
