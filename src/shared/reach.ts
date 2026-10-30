import type { Session } from "./types.ts";

type Reachable = Pick<Session, "pid" | "configDir">;

export const live = (session: Reachable): boolean => session.pid !== null;

export const sameAccount = (a: Reachable, b: Reachable): boolean =>
	a.configDir === b.configDir;
