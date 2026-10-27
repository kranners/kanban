import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	type Annotation,
	type Annotations,
	maxNoteText,
	type Note,
} from "../shared/types.ts";
import {
	createAnnotationStore,
	loadAnnotations,
	maxAnnotations,
	parseAnnotation,
	parseAnnotations,
} from "./annotations.ts";

const note = {
	kind: "note",
	x: 10,
	y: -20,
	w: 192,
	h: 192,
	z: 3,
	text: "ship the acme-api fix",
	color: "yellow",
};

const sticker = {
	kind: "sticker",
	x: 0,
	y: 0,
	w: 96,
	h: 96,
	z: 1,
	sticker: "rocket",
};

describe("parseAnnotation", () => {
	it("accepts notes and stickers and drops unknown fields", () => {
		assert.deepEqual(parseAnnotation("n-1", { ...note, extra: true }), {
			id: "n-1",
			...note,
		});
		assert.deepEqual(parseAnnotation("s_1", sticker), {
			id: "s_1",
			...sticker,
		});
		assert.deepEqual(parseAnnotation("s2", { ...sticker, rotation: -12 }), {
			id: "s2",
			...sticker,
			rotation: -12,
		});
	});

	it("holds a long report in one note", () => {
		assert.ok(maxNoteText >= 20_000);
		const text = "## Report\n\n".padEnd(maxNoteText, "x");
		assert.equal((parseAnnotation("r", { ...note, text }) as Note).text, text);
	});

	it("keeps the session a status report note is linked to", () => {
		const session = "11111111-2222-3333-4444-555555555555";
		assert.equal(
			(parseAnnotation("r", { ...note, session }) as Note).session,
			session,
		);
	});

	it("takes the id from the path, not the body", () => {
		const parsed = parseAnnotation("from-path", { ...note, id: "from-body" });
		assert.equal((parsed as Annotation).id, "from-path");
	});

	it("rejects bad ids, geometry, text, colours and stickers", () => {
		const cases: [string, unknown][] = [
			["../x", note],
			["__proto__", note],
			["a".repeat(65), note],
			["n", null],
			["n", { ...note, kind: "frame" }],
			["n", { ...note, x: Number.NaN }],
			["n", { ...note, y: 1e12 }],
			["n", { ...note, w: 4 }],
			["n", { ...note, h: 1e6 }],
			["n", { ...note, z: "1" }],
			["n", { ...note, z: Number.POSITIVE_INFINITY }],
			["n", { ...note, text: 5 }],
			["n", { ...note, text: "x".repeat(maxNoteText + 1) }],
			["n", { ...note, color: "red" }],
			["n", { ...note, color: undefined }],
			["n", { ...note, session: 7 }],
			["n", { ...note, session: "../etc" }],
			["s", { ...sticker, sticker: "../../etc/passwd" }],
			["s", { ...sticker, sticker: "constructor" }],
			["s", { ...sticker, rotation: 720 }],
		];
		for (const [id, body] of cases) {
			assert.ok(
				"error" in parseAnnotation(id, body),
				`${id} ${JSON.stringify(body)}`,
			);
		}
	});

	it("drops invalid entries from stored annotations", () => {
		assert.deepEqual(
			parseAnnotations({
				good: note,
				bad: { ...note, color: "teal" },
				"no/pe": note,
			}),
			{ good: { id: "good", ...note } },
		);
		assert.deepEqual(parseAnnotations([note]), {});
		assert.deepEqual(parseAnnotations(null), {});
	});
});

describe("createAnnotationStore", () => {
	const setup = async (initial: Annotations = {}) => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-annotations-"));
		const file = join(dir, "state", "annotations.json");
		const changes: Annotations[] = [];
		const store = createAnnotationStore({
			file,
			initial,
			onChange: (annotations) => changes.push(annotations),
		});
		return { dir, file, store, changes };
	};

	const parsed = (id: string, body: unknown) => {
		const annotation = parseAnnotation(id, body);
		if ("error" in annotation) throw new Error(annotation.error);
		return annotation;
	};

	it("persists changes atomically and reloads them", async () => {
		const { dir, file, store, changes } = await setup();
		assert.deepEqual(store.put(parsed("a", note)), { ok: true });
		store.put(parsed("b", sticker));
		store.put(parsed("a", { ...note, text: "edited" }));
		assert.equal(store.remove("b"), true);
		assert.equal(store.remove("b"), false);
		await store.saved();
		assert.equal(changes.length, 4);
		assert.deepEqual(store.current(), {
			a: { id: "a", ...note, text: "edited" },
		});
		assert.deepEqual(await loadAnnotations(file), store.current());
		assert.deepEqual(await readdir(join(dir, "state")), ["annotations.json"]);
	});

	it("treats a missing or corrupt file as no annotations", async () => {
		const { dir, file } = await setup();
		assert.deepEqual(await loadAnnotations(file), {});
		await writeFile(join(dir, "corrupt.json"), "{nope");
		assert.deepEqual(await loadAnnotations(join(dir, "corrupt.json")), {});
	});

	it("refuses new annotations past the cap but still updates existing ones", async () => {
		const full: Annotations = {};
		for (let index = 0; index < maxAnnotations; index += 1) {
			full[`n${index}`] = parsed(`n${index}`, note);
		}
		const { store, changes } = await setup(full);
		assert.ok("error" in store.put(parsed("extra", note)));
		assert.equal(changes.length, 0);
		assert.deepEqual(store.put(parsed("n0", { ...note, x: 99 })), {
			ok: true,
		});
	});

	it("does not mistake inherited keys for annotations", async () => {
		const { store } = await setup();
		assert.equal(store.remove("constructor"), false);
		store.put(parsed("constructor", note));
		assert.equal(Object.keys(store.current()).length, 1);
	});
});
