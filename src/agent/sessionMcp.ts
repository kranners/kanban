import { docServer, docsCaller } from "./docsClient.ts";
import { serve } from "./mcp.ts";

export { docServer, docsCaller, docsCallerAt } from "./docsClient.ts";

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
