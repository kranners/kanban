import { randomUUID } from "node:crypto";
import { sameEnd, samePair, touches } from "../shared/relations.ts";
import type {
	Board,
	Relation,
	RelationDraft,
	RelationEnd,
} from "../shared/types.ts";
import { pruneAfterMs } from "./layout.ts";
import { createStateFile, readState } from "./stateFile.ts";

export type RelationStore = {
	current(): Relation[];
	create(draft: RelationDraft): Relation | { error: string };
	remove(id: string): boolean;
	removeEnd(end: RelationEnd): void;
	observe(board: Board): void;
	saved(): Promise<void>;
};

export type RelationStoreOptions = {
	file: string;
	initial: Relation[];
	onChange: (relations: Relation[]) => void;
	newId?: () => string;
	now?: () => number;
};

export const maxRelations = 500;
const relationIdPattern = /^[A-Za-z0-9-]{1,64}$/;
const sessionIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

export const isRelationId = (value: string): boolean =>
	relationIdPattern.test(value);

const parseEnd = (value: unknown): RelationEnd | null => {
	if (typeof value !== "object" || value === null) return null;
	const { kind, id } = value as Record<string, unknown>;
	if (typeof id !== "string") return null;
	if (kind === "session" && sessionIdPattern.test(id)) return { kind, id };
	return null;
};

export const parseRelationDraft = (
	body: unknown,
): RelationDraft | { error: string } => {
	if (typeof body !== "object" || body === null) {
		return { error: "Expected a JSON object with from and to" };
	}
	const fields = body as Record<string, unknown>;
	const from = parseEnd(fields.from);
	const to = parseEnd(fields.to);
	if (!from || !to) {
		return { error: "from and to must each be a session" };
	}
	if (sameEnd(from, to)) return { error: "A card can't be linked to itself" };
	return { from, to };
};

const parseRelation = (value: unknown): Relation | null => {
	const draft = parseRelationDraft(value);
	if ("error" in draft) return null;
	const { id, createdAt } = value as Record<string, unknown>;
	if (typeof id !== "string" || !relationIdPattern.test(id)) return null;
	if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) {
		return null;
	}
	return { id, ...draft, createdAt };
};

export const parseRelations = (value: unknown): Relation[] => {
	if (!Array.isArray(value)) return [];
	const kept: Relation[] = [];
	for (const raw of value) {
		const relation = parseRelation(raw);
		if (!relation) continue;
		const repeated = kept.some(
			(other) => other.id === relation.id || samePair(other, relation),
		);
		if (!repeated) kept.push(relation);
	}
	return kept.slice(0, maxRelations);
};

export const loadRelations = (file: string): Promise<Relation[]> =>
	readState(file, parseRelations);

const sessionEnds = (relation: Relation): string[] =>
	[relation.from, relation.to].flatMap((end) =>
		end.kind === "session" ? [end.id] : [],
	);

export const createRelationStore = ({
	file,
	initial,
	onChange,
	newId = randomUUID,
	now = Date.now,
}: RelationStoreOptions): RelationStore => {
	let relations = [...initial];
	const missingSince = new Map<string, number>();
	const stored = createStateFile<Relation[]>(file);

	const commit = (next: Relation[]) => {
		relations = next;
		stored.write(relations);
		onChange(relations);
	};

	const pruned = (board: Board, list: Relation[]): Relation[] => {
		const time = now();
		const live = new Set(board.sessions.map((session) => session.id));
		const gone = new Set<string>();
		for (const id of list.flatMap(sessionEnds)) {
			if (live.has(id)) {
				missingSince.delete(id);
				continue;
			}
			const since = missingSince.get(id) ?? time;
			missingSince.set(id, since);
			if (time - since > pruneAfterMs) gone.add(id);
		}
		for (const id of gone) missingSince.delete(id);
		return gone.size === 0
			? list
			: list.filter(
					(relation) => !sessionEnds(relation).some((id) => gone.has(id)),
				);
	};

	return {
		current: () => relations,
		create(draft) {
			if (relations.some((relation) => samePair(relation, draft))) {
				return { error: "These two are already linked" };
			}
			if (relations.length >= maxRelations) {
				return { error: `The board holds at most ${maxRelations} links` };
			}
			const relation: Relation = { id: newId(), ...draft, createdAt: now() };
			commit([...relations, relation]);
			return relation;
		},
		remove(id) {
			if (!relations.some((relation) => relation.id === id)) return false;
			commit(relations.filter((relation) => relation.id !== id));
			return true;
		},
		removeEnd(end) {
			const kept = relations.filter((relation) => !touches(relation, end));
			if (kept.length !== relations.length) commit(kept);
		},
		observe(board) {
			const next = pruned(board, relations);
			if (next !== relations) commit(next);
		},
		saved: stored.saved,
	};
};
