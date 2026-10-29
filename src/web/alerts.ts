import type { Activity, Session } from "../shared/types.ts";

export type SeenActivities = ReadonlyMap<string, Activity>;

export function seenActivities(sessions: readonly Session[]): SeenActivities {
	return new Map(sessions.map((s) => [s.id, s.activity]));
}

export function summoned(
	previous: SeenActivities | null,
	sessions: readonly Session[],
): Session[] {
	if (!previous) return [];
	return sessions.filter(
		(s) => s.activity === "needs-you" && previous.get(s.id) !== "needs-you",
	);
}

export function titleFor(count: number): string {
	return count > 0 ? `(${count}) kanban` : "kanban";
}

const mark =
	'<rect width="32" height="32" rx="8" fill="#b5502f"/><rect x="7" y="8" width="7.5" height="16" rx="2" fill="#fff"/><rect x="17.5" y="8" width="7.5" height="7" rx="2" fill="#fff"/><rect x="17.5" y="17.5" width="7.5" height="6.5" rx="2" fill="#fff" fill-opacity=".6"/>';

export function faviconFor(count: number): string {
	if (count === 0) return "favicon.svg";
	const label = count > 9 ? "9+" : String(count);
	const badge = `<circle cx="22" cy="10" r="9" fill="#e2a428" stroke="#2a1d04" stroke-width="1.5"/><text x="22" y="14"text-anchor="middle" font-family="system-ui,sans-serif" font-size="${label.length > 1 ? 9.5 : 12}" font-weight="800" fill="#2a1d04">${label}</text>`;
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${mark}${badge}</svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function alertBody(session: Session): string {
	return session.needs ?? session.doing ?? session.project;
}
