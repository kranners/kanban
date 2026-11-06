// The board's doc tools for the sessions a runner carries. The board gives its
// own sessions a stdio MCP server that posts to its loopback; a session on a
// runner is on another machine, so the runner hands claude the same server,
// run as `runner.js --docs-mcp`, which posts each call to the hub with this
// machine's runner token instead.

import { docServer, docsCallerAt } from "../agent/docsClient.ts";
import type { CallTool } from "../agent/mcp.ts";

export const docsMcpFlag = "--docs-mcp";

/** Where a runner's sessions send doc tools on the hub. */
export const runnerDocsEndpoint = (hub: string): string =>
	`${hub.replace(/\/+$/, "")}/api/runners/docs`;

/**
 * The claude flags that give a runner's session the board's docs: one stdio
 * server, `kanban`, pre-approved, since a headless session can't be asked. The
 * token is not in them: the server reads it as the runner does, from the
 * environment or ~/.config/kanban/env, so it never sits on a command line.
 */
export const runnerDocsArgs = (
	node: string,
	script: string,
	hub: string,
): string[] => [
	`--mcp-config=${JSON.stringify({
		mcpServers: {
			kanban: {
				type: "stdio",
				command: node,
				args: [script, docsMcpFlag],
				env: { KANBAN_RUNNER_HUB: hub },
			},
		},
	})}`,
	"--allowedTools=mcp__kanban",
];

export const runnerDocsCaller = (
	hub: string,
	token: string,
	session: string,
	send: typeof fetch = fetch,
): CallTool =>
	docsCallerAt(
		runnerDocsEndpoint(hub),
		{ authorization: `Bearer ${token}`, "x-kanban-session": session },
		send,
	);

export { docServer };
