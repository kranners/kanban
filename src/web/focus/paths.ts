type PageLocation = Pick<Location, "protocol" | "host">;

export function attachUrl(
	location: PageLocation,
	short: string,
	cols: number,
	rows: number,
): string {
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	const query = new URLSearchParams({ cols: String(cols), rows: String(rows) });
	return `${scheme}://${location.host}/api/attach/${encodeURIComponent(short)}?${query}`;
}

export function mirrorUrl(location: PageLocation, sessionId: string): string {
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	return `${scheme}://${location.host}/api/mirror/${encodeURIComponent(sessionId)}`;
}

export function conversationUrl(
	location: PageLocation,
	node: { kind: "session" | "subagent"; id: string },
	since: string | null,
): string {
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	const collection = node.kind === "session" ? "sessions" : "subagents";
	const query = since ? `?${new URLSearchParams({ since })}` : "";
	return `${scheme}://${location.host}/api/${collection}/${encodeURIComponent(node.id)}/conversation${query}`;
}

export function filesUrl(id: string, query: string): string {
	return `/api/sessions/${encodeURIComponent(id)}/files?${new URLSearchParams({ q: query })}`;
}

export function commandsUrl(id: string): string {
	return `/api/sessions/${encodeURIComponent(id)}/commands`;
}

export function directoryName(cwd: string): string {
	return cwd.replace(/\/+$/, "").split("/").pop() ?? "";
}

export function isAbsoluteDirectory(cwd: string): boolean {
	return cwd.trim().startsWith("/");
}

export function needsTrust(error: string): boolean {
	return /trust/i.test(error);
}
