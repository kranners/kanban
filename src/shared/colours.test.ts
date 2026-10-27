import assert from "node:assert/strict";
import { test } from "node:test";
import {
	defaultRegionColour,
	isRegionColour,
	regionColours,
} from "./colours.ts";

test("defaultRegionColour is stable for a cwd and in the palette", () => {
	const cwd = "/Users/me/dev/acme-api";
	assert.equal(defaultRegionColour(cwd), defaultRegionColour(cwd));
	assert.ok(isRegionColour(defaultRegionColour(cwd)));
	assert.ok(isRegionColour(defaultRegionColour("")));
});

test("defaultRegionColour spreads projects across the palette", () => {
	const used = new Set(
		Array.from({ length: 64 }, (_, i) =>
			defaultRegionColour(`/Users/me/dev/project-${i}`),
		),
	);
	assert.equal(used.size, regionColours.length);
});

test("isRegionColour accepts only palette names", () => {
	assert.ok(isRegionColour("teal"));
	assert.ok(!isRegionColour("Teal"));
	assert.ok(!isRegionColour("#00ffff"));
	assert.ok(!isRegionColour(null));
});
