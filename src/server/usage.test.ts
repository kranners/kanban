import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Usage, UsageSample } from "../shared/types.ts";
import {
	createUsageMonitor,
	loadUsageSamples,
	parseSamples,
	parseUsageResponse,
	sampleWindowMs,
	usageUrl,
} from "./usage.ts";

const body = {
	five_hour: { utilization: 7, resets_at: "2026-10-28T01:10:00.503388+00:00" },
	seven_day: { utilization: 58.5, resets_at: null },
	seven_day_opus: null,
};

describe("parseUsageResponse", () => {
	it("reads the five-hour and seven-day windows", () => {
		assert.deepEqual(parseUsageResponse(body), {
			session: { percent: 7, resetsAt: Date.parse("2026-10-28T01:10:00.503Z") },
			week: { percent: 58.5, resetsAt: null },
		});
	});

	it("rejects a response with neither window", () => {
		assert.equal(parseUsageResponse({ five_hour: null }), null);
		assert.equal(parseUsageResponse({ seven_day: { utilization: "x" } }), null);
		assert.equal(parseUsageResponse("nope"), null);
	});

	it("drops malformed stored samples", () => {
		assert.deepEqual(
			parseSamples([{ at: 1, session: 2, week: 3 }, { at: 1 }, null]),
			[{ at: 1, session: 2, week: 3 }],
		);
		assert.deepEqual(parseSamples({}), []);
	});
});

describe("createUsageMonitor", () => {
	const setup = async (
		respond: (url: string, init?: RequestInit) => Response | Promise<Response>,
		options: { token?: string | null; initial?: UsageSample[] } = {},
	) => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-usage-"));
		const file = join(dir, "usage.json");
		const changes: Usage[] = [];
		let clock = 10 * sampleWindowMs;
		const requests: { url: string; init?: RequestInit }[] = [];
		const monitor = createUsageMonitor({
			file,
			initial: options.initial ?? [],
			token: async () =>
				options.token === undefined ? "secret-token" : options.token,
			fetch: (async (url: string, init?: RequestInit) => {
				requests.push({ url, init });
				return respond(url, init);
			}) as typeof fetch,
			now: () => clock,
			onChange: (usage) => changes.push(usage),
		});
		return {
			monitor,
			file,
			changes,
			requests,
			tick: (ms: number) => {
				clock += ms;
			},
		};
	};

	it("asks the usage API with the Claude Code token and records a sample", async () => {
		const { monitor, file, changes, requests } = await setup(() =>
			Response.json(body),
		);
		await monitor.check();
		assert.equal(requests[0]?.url, usageUrl);
		const headers = requests[0]?.init?.headers as Record<string, string>;
		assert.equal(headers.Authorization, "Bearer secret-token");
		assert.equal(headers["anthropic-beta"], "oauth-2025-04-20");
		assert.equal(changes.length, 1);
		assert.equal(monitor.current().week?.percent, 58.5);
		assert.equal(monitor.current().error, null);
		assert.deepEqual(monitor.current().samples, [
			{ at: 10 * sampleWindowMs, session: 7, week: 58.5 },
		]);
		await monitor.saved();
		assert.deepEqual(await loadUsageSamples(file), monitor.current().samples);
	});

	it("forgets samples older than the chart's week", async () => {
		const old = {
			at: 10 * sampleWindowMs - sampleWindowMs,
			session: 1,
			week: 1,
		};
		const recent = { at: 10 * sampleWindowMs - 1000, session: 2, week: 2 };
		const { monitor } = await setup(() => Response.json(body), {
			initial: [old, recent],
		});
		await monitor.check();
		assert.deepEqual(
			monitor.current().samples.map((sample) => sample.session),
			[2, 7],
		);
	});

	it("keeps the last reading and history when a check fails", async () => {
		let status = 200;
		const { monitor, tick } = await setup(() =>
			status === 200 ? Response.json(body) : new Response("", { status }),
		);
		await monitor.check();
		for (const [code, message] of [
			[401, "Claude Code sign-in expired"],
			[429, "Usage API rate limited"],
			[500, "Usage API returned 500"],
		] as const) {
			status = code;
			tick(60_000);
			await monitor.check();
			assert.equal(monitor.current().error, message);
			assert.equal(monitor.current().week?.percent, 58.5);
			assert.equal(monitor.current().samples.length, 1);
		}
		status = 200;
		await monitor.check();
		assert.equal(monitor.current().error, null);
		assert.equal(monitor.current().samples.length, 2);
	});

	it("reports a missing sign-in without calling the API", async () => {
		const { monitor, requests } = await setup(() => Response.json(body), {
			token: null,
		});
		await monitor.check();
		assert.equal(requests.length, 0);
		assert.equal(monitor.current().error, "Not signed in to Claude Code");
	});

	it("reports an unreachable API and an unexpected body", async () => {
		const offline = await setup(() => {
			throw new TypeError("fetch failed");
		});
		await offline.monitor.check();
		assert.equal(offline.monitor.current().error, "Usage API unreachable");
		const odd = await setup(() => Response.json({ hello: 1 }));
		await odd.monitor.check();
		assert.equal(
			odd.monitor.current().error,
			"Usage API sent an unexpected response",
		);
	});
});
