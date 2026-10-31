import { createInterface } from "node:readline";
import { parseToolCall, toolDefinitions } from "./tools.ts";

export type ToolReply = { text: string; isError: boolean };

export type CallTool = (name: string, args: unknown) => Promise<ToolReply>;

export type McpServer = {
	name: string;
	tools: readonly object[];
	parse(name: string, args: unknown): object | { error: string };
};

export const boardServer: McpServer = {
	name: "kanban",
	tools: toolDefinitions,
	parse: parseToolCall,
};

type Request = {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
	params?: unknown;
};

const fallbackProtocol = "2025-06-18";

const reply = (id: string | number, result: unknown) => ({
	jsonrpc: "2.0" as const,
	id,
	result,
});

const failure = (
	id: string | number | null,
	code: number,
	message: string,
) => ({
	jsonrpc: "2.0" as const,
	id,
	error: { code, message },
});

const isRequest = (value: unknown): value is Request =>
	typeof value === "object" &&
	value !== null &&
	typeof (value as Record<string, unknown>).method === "string";

export const handleMessage = async (
	message: unknown,
	call: CallTool,
	server: McpServer = boardServer,
): Promise<object | null> => {
	if (!isRequest(message)) return failure(null, -32600, "Invalid request");
	const { id, method } = message;
	const params = (message.params ?? {}) as Record<string, unknown>;
	if (id === undefined) return null;
	switch (method) {
		case "initialize":
			return reply(id, {
				protocolVersion:
					typeof params.protocolVersion === "string"
						? params.protocolVersion
						: fallbackProtocol,
				capabilities: { tools: {} },
				serverInfo: { name: server.name, version: "1.0.0" },
			});
		case "ping":
			return reply(id, {});
		case "tools/list":
			return reply(id, { tools: server.tools });
		case "tools/call": {
			const name = typeof params.name === "string" ? params.name : "";
			const parsed = server.parse(name, params.arguments);
			const result =
				"error" in parsed && typeof parsed.error === "string"
					? { text: parsed.error, isError: true }
					: await call(name, params.arguments ?? {});
			return reply(id, {
				content: [{ type: "text", text: result.text }],
				isError: result.isError,
			});
		}
		default:
			return failure(id, -32601, `Method not found: ${method}`);
	}
};

export const postTool = async (
	endpoint: string,
	headers: Record<string, string>,
	args: unknown,
	send: typeof fetch = fetch,
): Promise<ToolReply> => {
	try {
		const response = await send(endpoint, {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify(args),
		});
		const body = (await response.json().catch(() => null)) as {
			text?: unknown;
			error?: unknown;
		} | null;
		if (response.ok && typeof body?.text === "string") {
			return { text: body.text, isError: false };
		}
		const error = typeof body?.error === "string" ? body.error : "";
		return {
			text: error || `The board answered HTTP ${response.status}`,
			isError: true,
		};
	} catch (error) {
		return {
			text: `Could not reach the board: ${(error as Error).message}`,
			isError: true,
		};
	}
};

export const boardCaller =
	(url: string, token: string): CallTool =>
	(name, args) =>
		postTool(
			`${url}/api/agent/tools/${encodeURIComponent(name)}`,
			{ authorization: `Bearer ${token}` },
			args,
		);

export const serve = (call: CallTool, server: McpServer) => {
	const lines = createInterface({ input: process.stdin });
	const pending = new Set<Promise<void>>();
	lines.on("line", (line) => {
		if (line.trim() === "") return;
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			process.stdout.write(
				`${JSON.stringify(failure(null, -32700, "Parse error"))}\n`,
			);
			return;
		}
		const answered = handleMessage(message, call, server).then(
			(response) => {
				if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
			},
			(error: unknown) => {
				const id = isRequest(message) ? (message.id ?? null) : null;
				process.stdout.write(
					`${JSON.stringify(failure(id, -32603, (error as Error).message))}\n`,
				);
			},
		);
		pending.add(answered);
		answered.finally(() => pending.delete(answered));
	});
	lines.on("close", () =>
		Promise.allSettled(pending).then(() => process.exit(0)),
	);
};

if (import.meta.main) {
	const url = process.env.KANBAN_AGENT_URL;
	const token = process.env.KANBAN_AGENT_TOKEN;
	if (!url || !token) {
		console.error(
			"kanban mcp: KANBAN_AGENT_URL and KANBAN_AGENT_TOKEN are required",
		);
		process.exit(1);
	}
	serve(boardCaller(url, token), boardServer);
}
