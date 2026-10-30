import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { MirrorKey, RunsOn } from "../shared/types.ts";

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
			images?: number;
			account?: number | null;
			runsOn?: RunsOn;
			identity: string | null;
			result: string;
	  }
	| {
			action: "account-default";
			account: number;
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
	  }
	| {
			action: "session-report";
			sessionId: string;
			short: string | null;
			identity: string | null;
			result: string;
	  }
	| {
			action: "region-report";
			regionId: string;
			cwd: string;
			identity: string | null;
			result: string;
	  }
	| { action: "mirror-open"; sessionId: string; identity: string | null }
	| { action: "view-open"; sessionId: string; identity: string | null }
	| {
			action: "view-send";
			sessionId: string;
			kind: "prompt" | "key" | "permission" | "answer";
			key: string | null;
			chars: number | null;
			identity: string | null;
			result: string;
	  }
	| {
			action: "board-agent";
			thread: string;
			tool: string;
			target: string | null;
			input: string | null;
			result: string;
	  }
	| {
			action: "mirror-send";
			sessionId: string;
			surface: string | null;
			key: MirrorKey | null;
			chars: number | null;
			submit: boolean;
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
