import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startRunnerClient } from "./client.ts";

const shared = "s".repeat(40);
const own = "o".repeat(43);

describe("the runner client's own secret", () => {
	it("tries its own secret again at each registration, so a hub that refused to enrol it once can later", async () => {
		let enrolOpen = false;
		let enrolled = false;
		let registrations = 0;
		const bearers: string[] = [];
		const fakeHub: typeof fetch = async (input, init) => {
			const path = new URL(String(input)).pathname;
			const bearer = (init?.headers as Record<string, string> | undefined)
				?.authorization;
			const json = (status: number, body: unknown) =>
				new Response(JSON.stringify(body), {
					status,
					headers: { "content-type": "application/json" },
				});
			if (path === "/api/runners/enrol") {
				if (!enrolOpen)
					return json(403, { ok: false, error: "no address yet" });
				enrolled = true;
				return json(200, { ok: true, already: false });
			}
			if (path === "/api/runners/register") {
				bearers.push(bearer === `Bearer ${own}` ? "own" : "shared");
				if (bearer === `Bearer ${own}` && !enrolled)
					return json(403, { ok: false });
				registrations++;
				return json(200, {
					ok: true,
					id: "pilot",
					heartbeatMs: 20,
					pollWaitMs: 20,
				});
			}
			if (path.endsWith("/heartbeat")) {
				return registrations === 1 && enrolOpen
					? json(404, {})
					: json(200, { ok: true });
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
			return json(200, { commands: [] });
		};
		const client = startRunnerClient({
			config: {
				hub: "http://hub.test",
				token: shared,
				name: "pilot",
				cap: 1,
				claudeBin: "claude",
				claudeArgs: [],
				paths: [],
				cswapBin: "off",
			},
			secret: own,
			fetch: fakeHub,
			retryMs: 10,
			sessions: {
				launch: async () => ({ ok: true }),
				stop: async () => ({ ok: true }),
				list: () => [],
				pids: () => new Map(),
				stopAll: async () => {},
			},
			sample: async () => ({
				cpus: 1,
				cpuPercent: 0,
				load1: 0,
				memTotal: 1,
				memUsed: 0,
				diskTotal: 1,
				diskFree: 1,
			}),
			log: () => {},
		});
		await client.registered;
		assert.deepEqual(bearers, ["own", "shared"]);
		enrolOpen = true;
		for (let i = 0; i < 200 && registrations < 2; i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		await client.stop();
		assert.equal(enrolled, true);
		assert.deepEqual(bearers.slice(2), ["own", "own"]);
	});
});
