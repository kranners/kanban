import type { RelationDraft, RelationEnd } from "./types.ts";

export const endKey = (end: RelationEnd): string => `${end.kind}:${end.id}`;

export const sameEnd = (a: RelationEnd, b: RelationEnd): boolean =>
	a.kind === b.kind && a.id === b.id;

export const touches = (relation: RelationDraft, end: RelationEnd): boolean =>
	sameEnd(relation.from, end) || sameEnd(relation.to, end);

export const otherEnd = (
	relation: RelationDraft,
	end: RelationEnd,
): RelationEnd | null => {
	if (sameEnd(relation.from, end)) return relation.to;
	return sameEnd(relation.to, end) ? relation.from : null;
};

export const samePair = (a: RelationDraft, b: RelationDraft): boolean =>
	(sameEnd(a.from, b.from) && sameEnd(a.to, b.to)) ||
	(sameEnd(a.from, b.to) && sameEnd(a.to, b.from));

export const linkedTo = (
	relations: readonly RelationDraft[],
	end: RelationEnd,
): RelationEnd[] =>
	relations.flatMap((relation) => {
		const other = otherEnd(relation, end);
		return other ? [other] : [];
	});
