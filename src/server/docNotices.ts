export type DocNotices = {
	post(session: string, text: string): void;
	take(session: string): string[];
};

export const maxNoticesPerSession = 20;
export const noticeTtlMs = 24 * 60 * 60_000;

type Queued = { text: string; at: number };

export const createDocNotices = (now: () => number = Date.now): DocNotices => {
	const queues = new Map<string, Queued[]>();
	return {
		post(session, text) {
			const fresh = (queues.get(session) ?? []).filter(
				(notice) => now() - notice.at < noticeTtlMs && notice.text !== text,
			);
			queues.set(
				session,
				[...fresh, { text, at: now() }].slice(-maxNoticesPerSession),
			);
		},
		take(session) {
			const queued = queues.get(session) ?? [];
			queues.delete(session);
			return queued
				.filter((notice) => now() - notice.at < noticeTtlMs)
				.map((notice) => notice.text);
		},
	};
};
