import assert from "node:assert/strict";
import { test } from "node:test";
import type { Region, Session } from "../shared/types.ts";
import { gridSize } from "./grid.ts";
import { groupAt, groupsOf } from "./groups.ts";
import type { PlacedNode } from "./layout.ts";
import { sessionSize } from "./placement.ts";
import {
	arrangedRegion,
	belongsTo,
	isRegionKey,
	minRegionSize,
	regionGroups,
	spotInRegion,
	storableRegion,
} from "./regions.ts";

function session(id: string, cwd = "/dev/acme-api"): Session {
	return {
		id,
		short: id,
		pid: null,
		name: id,
		cwd,
		project: cwd.split("/").pop() ?? "",
		kind: "background",
		activity: "idle",
		doing: null,
		needs: null,
		startedAt: 1,
		updatedAt: 1,
		attachable: true,
	};
}

function node(id: string, x: number, y: number, follows?: string): PlacedNode {
	const kind = follows ? "subagent" : "session";
	return {
		key: `${kind}:${id}`,
		ref: { kind, id },
		family: 0,
		x,
		y,
		w: follows ? 216 : 312,
		h: follows ? 72 : 240,
		...(follows ? { follows } : {}),
	};
}

function nodes(...list: PlacedNode[]) {
	return new Map(list.map((n) => [n.key, n]));
}

function region(id: string, x: number, y: number, cwd = "/dev/acme-api") {
	return { id, cwd, name: null, x, y, w: 480, h: 336 } satisfies Region;
}

test("an empty region frames itself under its directory's name", () => {
	const [group] = regionGroups([region("r", 0, 0)], [], [], new Map());
	assert.deepEqual(group, {
		key: "region:r",
		project: "acme-api",
		cwd: "/dev/acme-api",
		members: [],
		frame: { x: 0, y: 0, w: 480, h: 336 },
		region: region("r", 0, 0),
	});
});

test("a session of the project whose card centre is inside belongs to it", () => {
	const sessions = [
		session("in"),
		session("worktree", "/dev/acme-api/.claude/worktrees/x"),
		session("other", "/dev/acme-web"),
		session("out"),
	];
	const placed = nodes(
		node("in", 24, 24),
		node("worktree", 48, 48),
		node("other", 24, 24),
		node("out", 2000, 0),
	);
	const [group] = regionGroups([region("r", 0, 0)], [], sessions, placed);
	assert.deepEqual([...(group?.members ?? [])].sort(), [
		"session:in",
		"session:worktree",
	]);
});

test("the frame grows to contain members and their followers", () => {
	const sessions = [session("a")];
	const placed = nodes(node("a", 240, 200), node("x", 240, 488, "session:a"));
	const [group] = regionGroups([region("r", 0, 0)], [], sessions, placed);
	assert.ok(group);
	assert.equal(group.frame.x, 0);
	assert.equal(group.frame.y, 0);
	assert.equal(group.frame.x + group.frame.w, 240 + 312 + gridSize);
	assert.equal(group.frame.y + group.frame.h, 488 + 72 + gridSize);
});

test("a derived group touching a region is adopted, so one frame shows", () => {
	const sessions = [session("a"), session("b"), session("c", "/dev/acme-web")];
	const placed = nodes(
		node("a", 24, 48),
		node("b", 24 + 312 + gridSize, 48),
		node("c", 4000, 0),
	);
	const derived = groupsOf(sessions, placed);
	assert.equal(derived.length, 1);
	const frames = regionGroups([region("r", 0, 0)], derived, sessions, placed);
	assert.equal(frames.length, 1);
	assert.deepEqual([...(frames[0]?.members ?? [])].sort(), [
		"session:a",
		"session:b",
	]);
	assert.ok((frames[0]?.frame.w ?? 0) > 480);
});

test("derived groups elsewhere are kept alongside regions", () => {
	const sessions = [session("a"), session("b")];
	const placed = nodes(node("a", 4000, 0), node("b", 4000 + 336, 0));
	const derived = groupsOf(sessions, placed);
	const frames = regionGroups([region("r", 0, 0)], derived, sessions, placed);
	assert.deepEqual(
		frames.map((g) => g.key),
		["region:r", derived[0]?.key],
	);
});

test("overlapping regions give a card to the smallest", () => {
	const small = { ...region("small", 0, 0), w: 360, h: 288 };
	const big = { ...region("big", 0, 0), w: 2400, h: 2400 };
	const frames = regionGroups(
		[big, small],
		[],
		[session("a")],
		nodes(node("a", 24, 24)),
	);
	assert.deepEqual(
		frames.map((g) => [g.key, g.members]),
		[
			["region:big", []],
			["region:small", ["session:a"]],
		],
	);
	assert.equal(groupAt(frames, { x: 30, y: 30 })?.key, "region:small");
});

test("belongsTo matches the directory and its subdirectories only", () => {
	const r = region("r", 0, 0);
	assert.ok(belongsTo(r, "/dev/acme-api"));
	assert.ok(belongsTo(r, "/dev/acme-api/packages/x"));
	assert.ok(!belongsTo(r, "/dev/acme-api-v2"));
	assert.ok(belongsTo({ cwd: "/" }, "/anything"));
});

test("a spot in a region keeps the new card's centre inside and clear", () => {
	const r = { ...region("r", 0, 0), w: 960, h: 672 };
	const centreInside = (at: { x: number; y: number }) => {
		const cx = at.x + sessionSize.w / 2;
		const cy = at.y + sessionSize.h / 2;
		return cx > r.x && cx < r.x + r.w && cy > r.y && cy < r.y + r.h;
	};
	const free = spotInRegion({ x: 460, y: 320 }, r, []);
	assert.ok(free && centreInside(free));
	const taken = [{ x: 0, y: 0, w: 312, h: 240 }];
	const beside = spotInRegion({ x: 0, y: 0 }, r, taken);
	assert.ok(beside && centreInside(beside));
	assert.ok(
		beside.x >= 312 + gridSize ||
			beside.y >= 240 + gridSize ||
			beside.x + 312 + gridSize <= 0 ||
			beside.y + 240 + gridSize <= 0,
	);
	const full = [{ x: -2000, y: -2000, w: 5000, h: 5000 }];
	assert.equal(spotInRegion({ x: 0, y: 0 }, r, full), null);
});

test("moving snaps the origin, resizing moves only the grabbed edges", () => {
	const origin = { x: 0, y: 0, w: 480, h: 336 };
	assert.deepEqual(arrangedRegion(origin, "move", 30, -13), {
		...origin,
		x: 24,
		y: -24,
	});
	assert.deepEqual(arrangedRegion(origin, "se", 50, 10), {
		x: 0,
		y: 0,
		w: 528,
		h: 336,
	});
	assert.deepEqual(arrangedRegion(origin, "nw", 48, 48), {
		x: 48,
		y: 48,
		w: 432,
		h: 288,
	});
	assert.deepEqual(arrangedRegion(origin, "w", 1000, 0), {
		x: 480 - minRegionSize.w,
		y: 0,
		w: minRegionSize.w,
		h: 336,
	});
	assert.deepEqual(arrangedRegion(origin, "n", 0, 1000), {
		x: 0,
		y: 336 - minRegionSize.h,
		w: 480,
		h: minRegionSize.h,
	});
});

test("a stored region is snapped and kept within its size bounds", () => {
	assert.deepEqual(storableRegion({ x: 13, y: -32, w: 10, h: 409 }), {
		x: 24,
		y: -24,
		w: minRegionSize.w,
		h: 408,
	});
});

test("R starts a region unless typing or modified", () => {
	const press = {
		key: "r",
		repeat: false,
		altKey: false,
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
	};
	assert.ok(isRegionKey(press, false));
	assert.ok(!isRegionKey(press, true));
	assert.ok(!isRegionKey({ ...press, metaKey: true }, false));
	assert.ok(!isRegionKey({ ...press, key: "a" }, false));
});
