import type { Server } from "node:http";
import { createServer, type Server as NetServer } from "node:net";
import { isLoopback } from "./config.ts";

export type Listening = { close(): void };

export type ListenOptions = {
	retryMs?: number;
	log?: (line: string) => void;
};

const label = (host: string, port: number) =>
	`${host.includes(":") ? `[${host}]` : host}:${port}`;

// Serve one HTTP server on several addresses. The first host is the server's
// own listen; every other one hands its connections to the same server, so
// routes, auth and WebSocket upgrades behave identically on each. A network
// address that isn't there yet (WireGuard still coming up after boot or wake)
// is retried rather than taking the board down; a loopback failure is fatal
// as before.
export const listenAll = (
	server: Server,
	hosts: readonly string[],
	port: number,
	onListening: (host: string) => void,
	{ retryMs = 10_000, log = console.error }: ListenOptions = {},
): Listening => {
	const [first, ...rest] = hosts;
	if (first === undefined) throw new Error("listenAll needs a host");
	const extras: NetServer[] = [];
	const timers = new Set<NodeJS.Timeout>();
	let closed = false;
	server.listen(port, first, () => onListening(first));
	const bind = (host: string) => {
		if (closed) return;
		const extra = createServer((socket) => server.emit("connection", socket));
		extra.on("error", (error: NodeJS.ErrnoException) => {
			if (isLoopback(host)) throw error;
			log(
				`kanban: can't listen on ${label(host, port)} (${error.code ?? error.message}); retrying in ${Math.round(retryMs / 1000)}s`,
			);
			extra.close();
			const timer = setTimeout(() => {
				timers.delete(timer);
				bind(host);
			}, retryMs);
			timers.add(timer);
		});
		extra.listen(port, host, () => {
			extras.push(extra);
			onListening(host);
		});
	};
	for (const host of rest) bind(host);
	server.on("close", () => close());
	const close = () => {
		closed = true;
		for (const timer of timers) clearTimeout(timer);
		timers.clear();
		for (const extra of extras) extra.close();
	};
	return { close };
};
