import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createProjectsSource,
	normaliseProjects,
	parseProjectsConfig,
	projectsFixture,
	stageOf,
	timeOf,
} from "./projects.ts";

const now = Date.parse("2026-11-09T05:00:00Z");
const day = 86_400_000;

describe("parseProjectsConfig", () => {
	it("is off with nothing set", () => {
		assert.deepEqual(parseProjectsConfig({}), { mode: "off" });
	});
	it("prefers the fixture, then a file, then a URL", () => {
		assert.deepEqual(
			parseProjectsConfig({
				KANBAN_PROJECTS_FIXTURE: "1",
				KANBAN_PROJECTS_URL: "https://example.com/p",
			}),
			{ mode: "fixture" },
		);
		assert.deepEqual(
			parseProjectsConfig({
				KANBAN_PROJECTS_FILE: "/tmp/p.json",
				KANBAN_PROJECTS_URL: "https://example.com/p",
			}),
			{ mode: "file", file: "/tmp/p.json" },
		);
		assert.deepEqual(
			parseProjectsConfig({
				KANBAN_PROJECTS_URL: "https://example.com/api/projects",
				KANBAN_PROJECTS_TOKEN: "abcdefgh12345678",
			}),
			{
				mode: "url",
				url: "https://example.com/api/projects",
				token: "abcdefgh12345678",
			},
		);
	});
	it("refuses credentials in the URL and odd schemes, never echoing a token", () => {
		assert.throws(() =>
			parseProjectsConfig({ KANBAN_PROJECTS_URL: "https://a:b@example.com/" }),
		);
		assert.throws(() =>
			parseProjectsConfig({ KANBAN_PROJECTS_URL: "file:///etc/passwd" }),
		);
		assert.throws(
			() =>
				parseProjectsConfig({
					KANBAN_PROJECTS_URL: "https://example.com/",
					KANBAN_PROJECTS_TOKEN: "short",
				}),
			(error: Error) => !error.message.includes("short"),
		);
	});
});

describe("normaliseProjects", () => {
	it("reads times as ISO, seconds or milliseconds", () => {
		assert.equal(timeOf("2026-11-09T05:00:00Z"), now);
		assert.equal(timeOf(now / 1000), now);
		assert.equal(timeOf(now), now);
		assert.equal(timeOf("nonsense"), null);
	});
	it("knows the stages and their aliases", () => {
		assert.equal(stageOf("Building"), "building");
		assert.equal(stageOf("maintain"), "maintaining");
		assert.equal(stageOf("parked"), "paused");
		assert.equal(stageOf("wat"), null);
	});
	it("turns the endpoint's shape into the board's", () => {
		const read = normaliseProjects(
			{
				updated: "2026-11-09T04:00:00Z",
				projects: [
					{
						id: "p1",
						title: "One",
						parent: null,
						area: "home",
						kind: "project",
						stage: "landing",
						state: "Nearly",
						next: "Ship it",
						blocked_on: "A review",
						created: "2026-10-01T00:00:00Z",
						touched: "2026-11-08T00:00:00Z",
						stage_since: "2026-11-07T00:00:00Z",
						links: [
							{ type: "kanban", ref: "session:abc12345ff" },
							{ type: "pr", ref: "x#1", url: "javascript:alert(1)" },
							{ type: "thread", ref: "123", url: "https://discord.com/x" },
						],
						history: [
							{ at: "2026-11-07T00:00:00Z", stage: "landing", note: "" },
							{ at: "2026-10-01T00:00:00Z", stage: "idea", note: "x" },
						],
						progress: 80,
						live: [
							{ type: "session", id: "def456", state: "working", title: "t" },
						],
					},
					{ id: "p1", title: "Duplicate" },
					{ title: "No id" },
				],
			},
			now,
		);
		assert.ok(read);
		assert.equal(read.updatedAt, now - 3_600_000);
		assert.equal(read.projects.length, 1);
		const [p] = read.projects;
		assert.ok(p);
		assert.equal(p.stage, "landing");
		assert.equal(p.blockedOn, "A review");
		assert.equal(p.progress, 0.8);
		assert.deepEqual(p.sessions, ["abc12345ff", "def456"]);
		assert.equal(p.links[1]?.url, null, "a script URL is dropped");
		assert.equal(p.links[2]?.url, "https://discord.com/x");
		assert.deepEqual(
			p.history.map((s) => s.stage),
			["idea", "landing"],
			"history is oldest first",
		);
		assert.equal(p.stale, false);
	});
	it("works out staleness when the source does not say", () => {
		const read = normaliseProjects(
			{
				projects: [
					{ id: "a", stage: "building", touched: now - 20 * day },
					{ id: "b", stage: "done", touched: now - 20 * day },
					{ id: "c", stage: "building", touched: now - 2 * day },
					{ id: "d", stage: "building", touched: now - 2 * day, stale: true },
				],
			},
			now,
		);
		assert.deepEqual(
			read?.projects.map((p) => p.stale),
			[true, false, false, true],
		);
	});
	it("refuses a body without a projects list", () => {
		assert.equal(normaliseProjects({ items: [] }, now), null);
		assert.equal(normaliseProjects(null, now), null);
	});
	it("reads every sample project", () => {
		const read = normaliseProjects(projectsFixture(now), now);
		assert.ok(read && read.projects.length >= 8);
		const stages = new Set(read.projects.map((p) => p.stage));
		for (const stage of ["idea", "planned", "building", "landing", "live"]) {
			assert.ok(stages.has(stage as never), stage);
		}
		assert.ok(read.projects.some((p) => p.parent !== null));
		assert.ok(read.projects.some((p) => p.blockedOn !== null));
		assert.ok(read.projects.some((p) => p.stale));
	});
});

describe("createProjectsSource", () => {
	const body = JSON.stringify({ projects: [{ id: "x", stage: "idea" }] });

	it("says unconfigured when off", async () => {
		const source = createProjectsSource({ config: { mode: "off" } });
		assert.equal((await source.list()).status, "unconfigured");
	});

	it("fetches with the bearer token and caches", async () => {
		let calls = 0;
		let auth: string | undefined;
		let clock = now;
		const source = createProjectsSource({
			config: {
				mode: "url",
				url: "https://example.com/p",
				token: "t0k3n-abcdef",
			},
			now: () => clock,
			fetch: (async (_url: string, init: RequestInit) => {
				calls++;
				auth = (init.headers as Record<string, string>).authorization;
				return new Response(body, { status: 200 });
			}) as typeof fetch,
		});
		const first = await source.list();
		assert.equal(first.status, "ok");
		assert.equal(first.projects[0]?.id, "x");
		assert.equal(auth, "Bearer t0k3n-abcdef");
		await source.list();
		assert.equal(calls, 1);
		clock += 31_000;
		await source.list();
		assert.equal(calls, 2);
	});

	it("keeps the last projects with the error when a read fails", async () => {
		let fail = false;
		let clock = now;
		const source = createProjectsSource({
			config: { mode: "url", url: "https://example.com/p", token: null },
			now: () => clock,
			fetch: (async () =>
				fail
					? new Response("no", { status: 502 })
					: new Response(body, { status: 200 })) as unknown as typeof fetch,
		});
		await source.list();
		fail = true;
		clock += 60_000;
		const kept = await source.list();
		assert.equal(kept.status, "ok");
		assert.equal(kept.projects.length, 1);
		assert.match(kept.error ?? "", /502/);
	});

	it("is unavailable when nothing was ever read", async () => {
		const source = createProjectsSource({
			config: { mode: "file", file: "/nowhere.json" },
			readFile: async () => {
				throw new Error("ENOENT");
			},
		});
		const listing = await source.list();
		assert.equal(listing.status, "unavailable");
		assert.deepEqual(listing.projects, []);
	});

	it("serves the fixture as sample projects", async () => {
		const source = createProjectsSource({ config: { mode: "fixture" } });
		const listing = await source.list();
		assert.equal(listing.status, "fixture");
		assert.ok(listing.projects.length > 0);
	});
});
