import { live, sameAccount } from "../shared/reach.ts";
import type { Session } from "../shared/types.ts";
import type { Group } from "./groups.ts";
import { nodeKey } from "./layout.ts";

export function unreachablePeers(
	projects: readonly Group[],
	sessions: readonly Session[],
): ReadonlyMap<string, Session[]> {
	const byKey = new Map(
		sessions.map((s) => [nodeKey({ kind: "session", id: s.id }), s]),
	);
	const unreachable = new Map<string, Session[]>();
	for (const project of projects) {
		const members = project.members
			.flatMap((key) => byKey.get(key) ?? [])
			.filter(live);
		for (const member of members) {
			const others = members.filter((other) => !sameAccount(member, other));
			if (others.length > 0) unreachable.set(member.id, others);
		}
	}
	return unreachable;
}

export const unreachableText = (others: readonly Session[]): string =>
	`Can't message ${others.map((s) => s.name).join(", ")} in this project: ${others.length === 1 ? "it runs" : "they run"} on another Claude account, and sessions can only message sessions on their own account.`;
