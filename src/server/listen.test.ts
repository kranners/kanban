import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { listenAll } from "./listen.ts";

const freePort = async (): Promise<number> => {
	const probe = createServer();
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
	const { port } = probe.address() as AddressInfo;
	await new Promise((resolve) => probe.close(resolve));
	return port;
};

const binds = (host: string) =>
	new Promise<boolean>((resolve) => {
		const probe = createServer();
		probe.once("error", () => resolve(false));
		probe.listen(0, host, () => probe.close(() => resolve(true)));
	});

// Linux answers on all of 127/8, macOS only on 127.0.0.1 and ::1.
const second = (await binds("127.0.0.2"))
	? "127.0.0.2"
	: (await binds("::1"))
		? "::1"
		: null;

describe("listenAll", () => {
	it("answers on every host with the same server", {
		skip: second === null && "no second loopback address here",
	}, async (t) => {
		const server = createServer((req, res) =>
			res.end(`${req.socket.localAddress}`),
		);
		const port = await freePort();
		const up: string[] = [];
		await new Promise<void>((resolve) => {
			listenAll(server, ["127.0.0.1", second as string], port, (host) => {
				up.push(host);
				if (up.length === 2) resolve();
			});
		});
		t.after(() => {
			server.closeAllConnections();
			server.close();
		});
		assert.deepEqual(up.sort(), ["127.0.0.1", second].sort());
		for (const [host, url] of [
			["127.0.0.1", `http://127.0.0.1:${port}/`],
			[second, `http://${second === "::1" ? "[::1]" : second}:${port}/`],
		] as const) {
			assert.match(await (await fetch(url)).text(), new RegExp(`${host}$`));
		}
	});

	it("keeps retrying a network address that isn't there yet", async (t) => {
		const server = createServer((_req, res) => res.end("ok"));
		const port = await freePort();
		const logged: string[] = [];
		const listening = await new Promise<ReturnType<typeof listenAll>>(
			(resolve) => {
				const handle = listenAll(
					server,
					["127.0.0.1", "192.0.2.123"],
					port,
					() => resolve(handle),
					{ retryMs: 20, log: (line) => logged.push(line) },
				);
			},
		);
		t.after(() => {
			listening.close();
			server.close();
		});
		await new Promise((resolve) => setTimeout(resolve, 120));
		assert.ok(logged.length >= 2, `retried: ${logged.join(" | ")}`);
		assert.match(logged[0] ?? "", /192\.0\.2\.123:\d+ .*retrying/);
		assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "ok");
	});
});
