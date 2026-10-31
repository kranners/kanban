export type AnticipatedPermission = {
	rule: string;
	reason: string;
};

export type PermissionSurveyEntry = {
	sessionId: string;
	name: string;
	cwd: string;
} & (
	| { ok: true; permissions: AnticipatedPermission[] }
	| { ok: false; error: string }
);

export type PermissionSurvey = { entries: PermissionSurveyEntry[] };

export type PermissionGrant = { sessionId: string; rules: string[] };

export type PermissionGrantResult = {
	sessionId: string;
	settingsPath: string;
} & ({ ok: true; added: string[] } | { ok: false; error: string });
