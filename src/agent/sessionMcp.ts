import { readFile, stat } from "node:fs/promises";
import { maxDocBytes } from "../shared/docPaths.ts";
import { docToolDefinitions, parseDocToolInput } from "./docTools.ts";
import { type CallTool, type McpServer, postTool, serve } from "./mcp.ts";

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

export const docsCaller =
	(url: string, session: string, send: typeof fetch = fetch): CallTool =>
	async (name, args) => {
		const post = (body: unknown) =>
			postTool(
				`${url}/api/docs/tools/${encodeURIComponent(name)}`,
				{ "x-kanban-session": session },
				body,
				send,
			);
		if (name !== "put_doc_asset") return post(args);
		const body = await assetBody(args);
		return "error" in body ? { text: body.error, isError: true } : post(body);
	};

if (import.meta.main) {
	const url = process.env.KANBAN_AGENT_URL;
	const session = process.env.CLAUDE_CODE_SESSION_ID;
	if (!url || !session) {
		console.error(
			"kanban session mcp: KANBAN_AGENT_URL and CLAUDE_CODE_SESSION_ID are required",
		);
		process.exit(1);
	}
	serve(docsCaller(url, session), docServer);
}
