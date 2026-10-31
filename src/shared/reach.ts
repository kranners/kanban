import type { Session } from "./types.ts";

type Reachable = Pick<Session, "pid" | "configDir">;

export const live = (session: Reachable): boolean => session.pid !== null;

export const sameAccount = (a: Reachable, b: Reachable): boolean =>
	a.configDir === b.configDir;

export const linkRefusal = (
	session: Pick<Session, "name" | "cloud" | "kind">,
): string | null => {
	if (session.cloud) {
		return `${session.name} runs in the cloud, where the board can't brief it or give it doc tools`;
	}
	if (session.kind === "interactive") {
		return `${session.name} runs in a terminal, where the board can't brief it or give it doc tools`;
	}
	return null;
};
