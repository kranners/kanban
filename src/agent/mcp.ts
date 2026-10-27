import { createInterface } from "node:readline";
import { parseToolCall, toolDefinitions } from "./tools.ts";

export type ToolReply = { text: string; isError: boolean };

export type CallTool = (name: string, args: unknown) => Promise<ToolReply>;

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
				serverInfo: { name: "kanban", version: "1.0.0" },
			});
		case "ping":
			return reply(id, {});
		case "tools/list":
			return reply(id, { tools: toolDefinitions });
		case "tools/call": {
			const name = typeof params.name === "string" ? params.name : "";
			const parsed = parseToolCall(name, params.arguments);
			const result =
				"error" in parsed
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

export const boardCaller =
	(url: string, token: string): CallTool =>
	async (name, args) => {
		try {
			const response = await fetch(
				`${url}/api/agent/tools/${encodeURIComponent(name)}`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(args),
				},
			);
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

const serve = (call: CallTool) => {
	const lines = createInterface({ input: process.stdin });
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
		handleMessage(message, call).then(
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
	});
	lines.on("close", () => process.exit(0));
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
	serve(boardCaller(url, token));
}
