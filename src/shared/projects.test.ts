import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	columnProjects,
	daysSince,
	lifecycleStrip,
	type Project,
	projectsOfSession,
} from "./projects.ts";

const project = (fields: Partial<Project>): Project => ({
	id: "p",
	title: "P",
	parent: null,
	area: "",
	kind: "",
	stage: "idea",
	state: "",
	next: "",
	blockedOn: null,
	createdAt: null,
	touchedAt: null,
	stageSince: null,
	links: [],
	history: [],
	stale: false,
	progress: null,
	live: [],
	sessions: [],
	...fields,
});

describe("lifecycleStrip", () => {
	it("marks stages behind, at and ahead of the current one", () => {
		const strip = lifecycleStrip(
			project({
				stage: "landing",
				history: [
					{ at: 1, stage: "idea", note: "" },
					{ at: 5, stage: "landing", note: "" },
				],
			}),
		);
		assert.deepEqual(
			strip.map((s) => s.state),
			["reached", "reached", "reached", "current", "ahead", "ahead", "ahead"],
		);
		assert.equal(strip[0]?.since, 1);
		assert.equal(strip[3]?.since, 5);
		assert.equal(strip[1]?.since, null, "planned was skipped");
	});
	it("shows where a paused project stopped", () => {
		const strip = lifecycleStrip(
			project({
				stage: "paused",
				history: [
					{ at: 1, stage: "planned", note: "" },
					{ at: 2, stage: "paused", note: "" },
				],
			}),
		);
		assert.equal(strip[1]?.state, "current");
	});
});

describe("columnProjects", () => {
	it("puts children right under their parent in the same column", () => {
		const projects = [
			project({ id: "a", stage: "building", touchedAt: 1 }),
			project({ id: "b", stage: "building", touchedAt: 3 }),
			project({ id: "a1", parent: "a", stage: "building", touchedAt: 2 }),
			project({ id: "a2", parent: "a", stage: "live" }),
			project({ id: "z", stage: "paused" }),
		];
		assert.deepEqual(
			columnProjects(projects, "building").map(
				({ project, depth }) => `${project.id}:${depth}`,
			),
			["b:0", "a:0", "a1:1"],
		);
		assert.deepEqual(
			columnProjects(projects, "aside").map(({ project }) => project.id),
			["z"],
		);
	});
	it("survives a parent loop", () => {
		const projects = [
			project({ id: "a", parent: "b", stage: "idea" }),
			project({ id: "b", parent: "a", stage: "idea" }),
		];
		assert.equal(columnProjects(projects, "idea").length, 2);
	});
});

describe("projectsOfSession", () => {
	it("matches by id, short id or a long enough prefix", () => {
		const projects = [
			project({ id: "x", sessions: ["a1f0c2d4e5"] }),
			project({ id: "y", sessions: ["k7"] }),
			project({ id: "z", sessions: ["a1f0c2d4"] }),
			project({ id: "w", sessions: ["a1f0"] }),
		];
		assert.deepEqual(
			projectsOfSession(projects, { id: "a1f0c2d4e5", short: "k7" }).map(
				(p) => p.id,
			),
			["x", "y", "z"],
		);
	});
});

describe("daysSince", () => {
	it("counts whole days", () => {
		assert.equal(daysSince(0, 3 * 86_400_000 + 5), 3);
		assert.equal(daysSince(null, 5), null);
		assert.equal(daysSince(10, 5), 0);
	});
});
