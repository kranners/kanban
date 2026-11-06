// The board's doc tools as an MCP server's caller, shared by the board's own
// session server (sessionMcp.ts) and a runner's (src/runner/docsMcp.ts). No
// entry point here, so bundling it into runner.js runs nothing.
import { readFile, stat } from "node:fs/promises";
import { maxDocBytes } from "../shared/docPaths.ts";
import { docToolDefinitions, parseDocToolInput } from "./docTools.ts";
import { type CallTool, type McpServer, postTool } from "./mcp.ts";

export const docServer: McpServer = {
	name: "kanban",
	tools: docToolDefinitions,
	parse: parseDocToolInput,
};

type AssetBody = { store?: string; path: string; data: string };

const assetBody = async (
	args: unknown,
): Promise<AssetBody | { error: string }> => {
	const input = parseDocToolInput("put_doc_asset", args);
	if ("error" in input) return input;
	if (input.tool !== "put_doc_asset") return { error: "Not an asset" };
	const { tool, file, ...target } = input;
	const info = await stat(file).catch(() => null);
	if (!info?.isFile()) return { error: `${file} isn't a file` };
	if (info.size > maxDocBytes) {
		return { error: `${file} is over the ${maxDocBytes} byte limit` };
	}
	return { ...target, data: (await readFile(file)).toString("base64") };
};

/** Posts each doc tool to `${endpoint}/<tool>` with these headers. */
export const docsCallerAt =
	(
		endpoint: string,
		headers: Record<string, string>,
		send: typeof fetch = fetch,
	): CallTool =>
	async (name, args) => {
		const post = (body: unknown) =>
			postTool(`${endpoint}/${encodeURIComponent(name)}`, headers, body, send);
		if (name !== "put_doc_asset") return post(args);
		const body = await assetBody(args);
		return "error" in body ? { text: body.error, isError: true } : post(body);
	};

export const docsCaller = (
	url: string,
	session: string,
	send: typeof fetch = fetch,
): CallTool =>
	docsCallerAt(`${url}/api/docs/tools`, { "x-kanban-session": session }, send);
