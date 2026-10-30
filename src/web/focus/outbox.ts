import { effect, signal } from "@preact/signals";
import { maxPromptText } from "../../shared/conversation.ts";
import { board } from "../state.ts";
import { type Outgoing, settleSend, stepOutbox } from "./conversation.ts";
import { type Conversation, holdConversation } from "./useConversation.ts";

export const outboxes = signal<Record<string, Outgoing[]>>({});
export const outboxProblems = signal<Record<string, string | null>>({});

const clock = signal(0);
const holds = new Map<string, ReturnType<typeof holdConversation>>();
const wakeups = new Map<string, number>();
const retryAt = new Map<string, number>();

export const editable = (entry: Outgoing): boolean =>
	entry.state === "queued" || entry.state === "held";

const updateOutbox = (
	sessionId: string,
	update: (outbox: Outgoing[]) => Outgoing[],
) => {
	outboxes.value = {
		...outboxes.value,
		[sessionId]: update(outboxes.value[sessionId] ?? []),
	};
};

const setProblem = (sessionId: string, problem: string | null) => {
	if ((outboxProblems.value[sessionId] ?? null) === problem) return;
	outboxProblems.value = { ...outboxProblems.value, [sessionId]: problem };
};

const wakeAt = (sessionId: string, at: number | null) => {
	clearTimeout(wakeups.get(sessionId));
	wakeups.delete(sessionId);
	if (at === null) return;
	wakeups.set(
		sessionId,
		window.setTimeout(
			() => {
				wakeups.delete(sessionId);
				clock.value += 1;
			},
			Math.max(0, at - Date.now()),
		),
	);
};

const deliver = (
	sessionId: string,
	request: Conversation["request"],
	sending: Outgoing,
) => {
	void request({ type: "prompt", text: sending.text }).then((outcome) => {
		const settled = settleSend(
			outboxes.value[sessionId] ?? [],
			sending.id,
			outcome,
			Date.now(),
		);
		if (settled.retryAt !== null) retryAt.set(sessionId, settled.retryAt);
		updateOutbox(sessionId, () => settled.outbox);
		if (settled.problem) setProblem(sessionId, settled.problem);
	});
};

const drive = (sessionId: string, outbox: Outgoing[]) => {
	if (outbox.length === 0) {
		holds.get(sessionId)?.release();
		holds.delete(sessionId);
		wakeAt(sessionId, null);
		retryAt.delete(sessionId);
		setProblem(sessionId, null);
		return;
	}
	const hold =
		holds.get(sessionId) ??
		holdConversation({ kind: "session", id: sessionId });
	holds.set(sessionId, hold);
	const { view, request } = hold.conversation;
	const current = view.value;
	const activity =
		board.value?.sessions.find((session) => session.id === sessionId)
			?.activity ?? null;
	const now = Date.now();
	const paused = (retryAt.get(sessionId) ?? 0) > now;
	const step = stepOutbox(outbox, {
		items: current.window.items,
		loaded: current.status !== null,
		working: activity === "working",
		deliverable:
			activity !== null &&
			activity !== "working" &&
			current.drive?.mode === "drive" &&
			current.connection === "open" &&
			current.dialog === null &&
			!paused,
		maxText: maxPromptText,
		now,
	});
	if (step.outbox !== outbox) updateOutbox(sessionId, () => step.outbox);
	if (!step.outbox.some((entry) => entry.state === "held")) {
		setProblem(sessionId, null);
	}
	if (step.lost) {
		setProblem(
			sessionId,
			"Claude never showed a message, so it is held. Check the transcript, then send, edit or remove it.",
		);
	}
	if (step.sending) {
		retryAt.delete(sessionId);
		deliver(sessionId, request, step.sending);
	}
	const wakes = [step.due, paused ? retryAt.get(sessionId) : null].filter(
		(at): at is number => typeof at === "number",
	);
	wakeAt(sessionId, wakes.length > 0 ? Math.min(...wakes) : null);
};

effect(() => {
	clock.value;
	const all = outboxes.value;
	for (const sessionId of new Set([...Object.keys(all), ...holds.keys()])) {
		drive(sessionId, all[sessionId] ?? []);
	}
});

addEventListener("beforeunload", (event) => {
	const undelivered = Object.values(outboxes.value).some((outbox) =>
		outbox.some((entry) => entry.state !== "echoed"),
	);
	if (undelivered) event.preventDefault();
});

export function queue(sessionId: string, text: string) {
	setProblem(sessionId, null);
	const now = Date.now();
	updateOutbox(sessionId, (current) => [
		...current,
		{ id: `${now}-${current.length}`, text, state: "queued", sentAt: now },
	]);
}

export function withdraw(sessionId: string, ids: string[]): string | null {
	const picked = (outboxes.value[sessionId] ?? []).filter(
		(entry) => editable(entry) && ids.includes(entry.id),
	);
	if (picked.length === 0) return null;
	setProblem(sessionId, null);
	updateOutbox(sessionId, (current) =>
		current.filter((entry) => !picked.includes(entry)),
	);
	return picked.map((entry) => entry.text).join("\n");
}

export function release(sessionId: string, id: string) {
	setProblem(sessionId, null);
	updateOutbox(sessionId, (current) =>
		current.map((entry) =>
			entry.id === id && entry.state === "held"
				? { ...entry, state: "queued" }
				: entry,
		),
	);
}
