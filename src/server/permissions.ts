import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
	AnticipatedPermission,
	PermissionGrant,
	PermissionGrantResult,
	PermissionSurvey,
	PermissionSurveyEntry,
} from "../shared/permissions.ts";
import type { Activity, Session } from "../shared/types.ts";
import type { SessionAsker } from "./exit.ts";

export const surveyPrompt =
	"The kanban board is gathering the permissions this session will need, so the user can approve them all at once. Do not do any more work. " +
	"List the Claude Code permission rules you expect to need to finish your task unattended, in permission-rule syntax, " +
	'such as "Bash(npm run test:*)", "Edit(src/**)", "WebFetch(domain:example.com)" or "mcp__server__tool". ' +
	"Prefer rules broad enough that you will not need to ask again. Give each a one-line reason. " +
	'Answer with JSON only, in the shape {"permissions":[{"rule":"...","reason":"..."}]}, and an empty list if you need nothing more.';

export const maxRules = 50;
export const maxRuleLength = 300;
export const maxReasonLength = 200;
export const maxGrants = 200;

const finished: readonly Activity[] = ["done", "failed", "stopped"];

const rulePattern =
	/^[A-Za-z][\w-]*(\([^()\p{C}\p{Zl}\p{Zp}]*[^()\s\p{C}][^()\p{C}\p{Zl}\p{Zp}]*\))?$/u;

export const isPermissionRule = (rule: unknown): rule is string =>
	typeof rule === "string" &&
	rule.length <= maxRuleLength &&
	rulePattern.test(rule);

const jsonCandidates = (text: string): string[] => {
	const trimmed = text.trim();
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1];
	const between = (open: string, close: string) => {
		const start = trimmed.indexOf(open);
		const end = trimmed.lastIndexOf(close);
		return start >= 0 && end > start ? [trimmed.slice(start, end + 1)] : [];
	};
	return [
		trimmed,
		...(fenced ? [fenced] : []),
		...between("{", "}"),
		...between("[", "]"),
	];
};

const permissionList = (value: unknown): unknown[] | null => {
	if (Array.isArray(value)) return value;
	const list = (value as { permissions?: unknown } | null)?.permissions;
	return Array.isArray(list) ? list : null;
};

export const parsePermissions = (
	answer: string,
):
	| { ok: true; permissions: AnticipatedPermission[] }
	| { ok: false; error: string } => {
	for (const candidate of jsonCandidates(answer)) {
		let list: unknown[] | null;
		try {
			list = permissionList(JSON.parse(candidate));
		} catch {
			continue;
		}
		if (!list) continue;
		const permissions = new Map<string, AnticipatedPermission>();
		for (const item of list) {
			const { rule, reason } = (
				typeof item === "string" ? { rule: item } : (item ?? {})
			) as Record<string, unknown>;
			const trimmed = typeof rule === "string" ? rule.trim() : rule;
			if (!isPermissionRule(trimmed) || permissions.has(trimmed)) continue;
			permissions.set(trimmed, {
				rule: trimmed,
				reason:
					typeof reason === "string"
						? reason.trim().slice(0, maxReasonLength)
						: "",
			});
			if (permissions.size === maxRules) break;
		}
		if (list.length > 0 && permissions.size === 0) {
			return {
				ok: false,
				error: "The session's rules were not valid permission rules",
			};
		}
		return { ok: true, permissions: [...permissions.values()] };
	}
	return {
		ok: false,
		error: "The session did not answer with a permission list",
	};
};

export const parseGrants = (
	body: unknown,
): { grants: PermissionGrant[] } | { error: string } => {
	if (!Array.isArray(body) || body.length > maxGrants) {
		return { error: `Expected a list of at most ${maxGrants} grants` };
	}
	const grants: PermissionGrant[] = [];
	for (const item of body) {
		const { sessionId, rules } = (item ?? {}) as Record<string, unknown>;
		if (typeof sessionId !== "string" || !Array.isArray(rules)) {
			return { error: "Each grant needs a sessionId and a list of rules" };
		}
		if (rules.length > maxRules || !rules.every(isPermissionRule)) {
			return {
				error: `Each grant takes at most ${maxRules} permission rules, like Bash(npm run test:*)`,
			};
		}
		grants.push({ sessionId, rules });
	}
	return { grants };
};

const isRunning = (session: Session) => !finished.includes(session.activity);

export const settingsPathFor = (cwd: string): string =>
	join(cwd, ".claude", "settings.local.json");

type SettingsRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is SettingsRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const readSettings = async (path: string): Promise<SettingsRecord> => {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	const settings: unknown = text.trim() ? JSON.parse(text) : {};
	if (!isRecord(settings)) throw new Error("settings are not a JSON object");
	return settings;
};

export const mergeAllowRules = async (
	path: string,
	rules: string[],
): Promise<string[]> => {
	const settings = await readSettings(path);
	const permissions = settings.permissions ?? {};
	if (!isRecord(permissions)) throw new Error("permissions is not an object");
	const allow = permissions.allow ?? [];
	if (!Array.isArray(allow)) throw new Error("permissions.allow is not a list");
	const added = [...new Set(rules)].filter((rule) => !allow.includes(rule));
	if (added.length === 0) return added;
	settings.permissions = { ...permissions, allow: [...allow, ...added] };
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`);
	await rename(temporary, path);
	return added;
};

export type PermissionDeps = {
	sessions(): Session[];
	isExiting(sessionId: string): boolean;
	ask: SessionAsker;
};

export type Permissions = {
	survey(): Promise<PermissionSurvey>;
	grant(grants: PermissionGrant[]): Promise<PermissionGrantResult[]>;
};

export const createPermissions = (deps: PermissionDeps): Permissions => {
	const writes = new Map<string, Promise<unknown>>();
	const serialized = <T>(path: string, write: () => Promise<T>): Promise<T> => {
		const next = (writes.get(path) ?? Promise.resolve())
			.catch(() => undefined)
			.then(write);
		writes.set(path, next);
		void next
			.catch(() => undefined)
			.then(() => {
				if (writes.get(path) === next) writes.delete(path);
			});
		return next;
	};

	const surveyOne = async (
		session: Session,
	): Promise<PermissionSurveyEntry> => {
		const header = {
			sessionId: session.id,
			name: session.name,
			cwd: session.cwd,
		};
		if (session.cloud) {
			return {
				...header,
				ok: false,
				error: "Runs in the cloud, so it can't be asked",
			};
		}
		if (!session.cwd) {
			return {
				...header,
				ok: false,
				error: "This session has no local folder",
			};
		}
		try {
			const answer = await deps.ask(session, surveyPrompt);
			if (!answer.ok) return { ...header, ok: false, error: answer.error };
			return { ...header, ...parsePermissions(answer.answer) };
		} catch (error) {
			return { ...header, ok: false, error: (error as Error).message };
		}
	};

	const grantOne = async ({
		sessionId,
		rules,
	}: PermissionGrant): Promise<PermissionGrantResult> => {
		const session = deps.sessions().find(({ id }) => id === sessionId);
		if (!session) {
			return {
				sessionId,
				settingsPath: "",
				ok: false,
				error: "No such session",
			};
		}
		if (session.cloud || !session.cwd) {
			return {
				sessionId,
				settingsPath: "",
				ok: false,
				error: "This session has no local folder",
			};
		}
		const settingsPath = settingsPathFor(session.cwd);
		try {
			const added = await serialized(settingsPath, () =>
				mergeAllowRules(settingsPath, rules),
			);
			return { sessionId, settingsPath, ok: true, added };
		} catch (error) {
			return {
				sessionId,
				settingsPath,
				ok: false,
				error: `Could not update ${settingsPath}: ${(error as Error).message}`,
			};
		}
	};

	return {
		survey: async () => ({
			entries: await Promise.all(
				deps
					.sessions()
					.filter(
						(session) => isRunning(session) && !deps.isExiting(session.id),
					)
					.map(surveyOne),
			),
		}),
		grant: (grants) => Promise.all(grants.map(grantOne)),
	};
};
