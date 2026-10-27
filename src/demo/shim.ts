import type { Backend, Channel, Peer } from "./backend.ts";

const connecting = 0;
const open = 1;
const closing = 2;
const closed = 3;

export function apiPath(url: URL): string | null {
	const at = url.pathname.indexOf("/api/");
	return at === -1 ? null : url.pathname.slice(at);
}

const later = (run: () => void) => setTimeout(run, 0);

export function install(backend: Backend, base: string): void {
	const network = globalThis.fetch.bind(globalThis);

	globalThis.fetch = async (input, init) => {
		const request = input instanceof Request ? input : null;
		const url = new URL(request?.url ?? String(input), base);
		const path = apiPath(url);
		if (path === null) return network(input, init);
		const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
		const text =
			typeof init?.body === "string"
				? init.body
				: ((await request?.text()) ?? "");
		let body: unknown = null;
		try {
			body = text === "" ? null : JSON.parse(text);
		} catch {
			return Response.json(
				{ ok: false, error: "Invalid JSON body" },
				{ status: 400 },
			);
		}
		return backend.fetch(method, path, url.searchParams, body);
	};

	class DemoSocket extends EventTarget {
		static readonly CONNECTING = connecting;
		static readonly OPEN = open;
		static readonly CLOSING = closing;
		static readonly CLOSED = closed;
		readonly CONNECTING = connecting;
		readonly OPEN = open;
		readonly CLOSING = closing;
		readonly CLOSED = closed;
		readonly url: string;
		readonly protocol = "";
		readonly extensions = "";
		readonly bufferedAmount = 0;
		readyState = connecting;
		binaryType: BinaryType = "blob";
		onopen: ((event: Event) => void) | null = null;
		onmessage: ((event: MessageEvent) => void) | null = null;
		onclose: ((event: Event) => void) | null = null;
		onerror: ((event: Event) => void) | null = null;
		#channel: Channel | null = null;

		constructor(url: string | URL) {
			super();
			this.url = String(url);
			this.addEventListener("open", (event) => this.onopen?.(event));
			this.addEventListener("message", (event) =>
				this.onmessage?.(event as MessageEvent),
			);
			this.addEventListener("close", (event) => this.onclose?.(event));
			this.addEventListener("error", (event) => this.onerror?.(event));
			later(() => this.#connect());
		}

		#connect(): void {
			if (this.readyState !== connecting) return;
			const path = apiPath(new URL(this.url, base));
			const opener = path === null ? null : backend.socket(path);
			if (!opener) {
				this.readyState = closed;
				this.dispatchEvent(new Event("error"));
				this.dispatchEvent(new Event("close"));
				return;
			}
			this.readyState = open;
			this.dispatchEvent(new Event("open"));
			const peer: Peer = {
				send: (data) =>
					later(() => {
						if (this.readyState === open)
							this.dispatchEvent(new MessageEvent("message", { data }));
					}),
				close: () => this.close(),
			};
			this.#channel = opener(peer);
		}

		send(data: string): void {
			if (this.readyState !== open)
				throw new DOMException("The socket is not open", "InvalidStateError");
			const channel = this.#channel;
			later(() => channel?.receive(String(data)));
		}

		close(): void {
			if (this.readyState === closing || this.readyState === closed) return;
			this.readyState = closed;
			this.#channel?.close();
			this.#channel = null;
			later(() => this.dispatchEvent(new Event("close")));
		}
	}

	globalThis.WebSocket = DemoSocket as unknown as typeof WebSocket;
}
