import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { agentMarker, isAgentDir } from "./claudeRuns.ts";
import { fromLoopback } from "./loopback.ts";

const request = (
	remoteAddress: string,
	headers: Record<string, string> = {},
): IncomingMessage =>
	({ socket: { remoteAddress }, headers }) as unknown as IncomingMessage;

describe("loopback", () => {
	it("admits this Mac's own processes and nothing through the tunnel", () => {
		assert.equal(fromLoopback(request("127.0.0.1")), true);
		assert.equal(fromLoopback(request("::ffff:127.0.0.1")), true);
		assert.equal(fromLoopback(request("::1")), true);
		assert.equal(fromLoopback(request("192.168.1.20")), false);
		assert.equal(fromLoopback(request("10.100.0.1")), false);
		assert.equal(
			fromLoopback(request("127.0.0.1", { "cf-connecting-ip": "1.2.3.4" })),
			false,
		);
	});

	it("knows the board's own Claude runs by a marker any server can see", async () => {
		const dir = await mkdtemp(join(tmpdir(), "kanban-runs-"));
		assert.equal(isAgentDir(dir), false);
		await writeFile(join(dir, agentMarker), "");
		assert.equal(isAgentDir(dir), true);
	});
});
