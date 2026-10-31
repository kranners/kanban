import type {
	PermissionGrant,
	PermissionSurveyEntry,
} from "../shared/permissions.ts";

export const ruleKey = (sessionId: string, rule: string): string =>
	`${sessionId}\n${rule}`;

export function allRuleKeys(entries: PermissionSurveyEntry[]): Set<string> {
	return new Set(
		entries.flatMap((entry) =>
			entry.ok
				? entry.permissions.map((permission) =>
						ruleKey(entry.sessionId, permission.rule),
					)
				: [],
		),
	);
}

export function grantsFor(
	entries: PermissionSurveyEntry[],
	selected: ReadonlySet<string>,
): PermissionGrant[] {
	return entries.flatMap((entry) => {
		if (!entry.ok) return [];
		const rules = [
			...new Set(
				entry.permissions
					.map((permission) => permission.rule)
					.filter((rule) => selected.has(ruleKey(entry.sessionId, rule))),
			),
		];
		return rules.length > 0 ? [{ sessionId: entry.sessionId, rules }] : [];
	});
}

export function isBroadRule(rule: string): boolean {
	const specifier = rule.match(/\((.*)\)$/)?.[1]?.trim();
	if (specifier === undefined) return !rule.startsWith("mcp__");
	return /^(\*|\/\/|~)|\.\./.test(specifier);
}

export function narrowRuleKeys(entries: PermissionSurveyEntry[]): Set<string> {
	return new Set(
		[...allRuleKeys(entries)].filter(
			(key) => !isBroadRule(key.slice(key.indexOf("\n") + 1)),
		),
	);
}
