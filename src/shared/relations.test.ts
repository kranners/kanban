import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	endKey,
	linkedTo,
	otherEnd,
	sameEnd,
	samePair,
	touches,
} from "./relations.ts";

const api = { kind: "session", id: "api" } as const;
const web = { kind: "session", id: "web" } as const;
const guide = { kind: "docs", id: "guide" } as const;

describe("relation ends", () => {
	it("key like board nodes and compare by kind and id", () => {
		assert.equal(endKey(api), "session:api");
		assert.equal(endKey(guide), "docs:guide");
		assert.equal(sameEnd(api, { kind: "session", id: "api" }), true);
		assert.equal(sameEnd(guide, { kind: "session", id: "guide" }), false);
	});

	it("find the far end and the same pair either way round", () => {
		const relation = { from: api, to: guide };
		assert.equal(touches(relation, guide), true);
		assert.equal(touches(relation, web), false);
		assert.deepEqual(otherEnd(relation, api), guide);
		assert.deepEqual(otherEnd(relation, guide), api);
		assert.equal(otherEnd(relation, web), null);
		assert.equal(samePair(relation, { from: guide, to: api }), true);
		assert.equal(samePair(relation, { from: api, to: web }), false);
	});

	it("list everything linked to one end", () => {
		const relations = [
			{ from: api, to: guide },
			{ from: web, to: api },
			{ from: web, to: guide },
		];
		assert.deepEqual(linkedTo(relations, api), [guide, web]);
		assert.deepEqual(linkedTo(relations, guide), [api, web]);
	});
});
