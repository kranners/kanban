import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type AuditEvent =
	| { action: "attach-open"; short: string; identity: string | null }
	| {
			action: "attach-close";
			short: string;
			identity: string | null;
			reason: "socket-closed" | "taken-over" | "exited";
	  }
	| {
			action: "session-create";
			cwd: string;
			name: string | null;
			identity: string | null;
			result: string;
	  }
	| {
			action: "session-exit";
			sessionId: string;
			short: string | null;
			kind: "interactive" | "background";
			force: boolean;
			identity: string | null;
			result: string;
	  };

export type Audit = (event: AuditEvent) => void;

export const fileAudit = (path: string): Audit => {
	const ready = mkdir(dirname(path), { recursive: true });
	let queue: Promise<unknown> = ready;
	return (event) => {
		const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`;
		queue = queue
			.then(() => appendFile(path, line))
			.catch((error: unknown) => console.error("audit write failed", error));
	};
};
