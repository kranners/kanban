import { MessagesSquare, PanelRightClose, PanelRightOpen } from "lucide-preact";
import type { NodeRef } from "../shared/types.ts";
import {
	board,
	hoveredMessage,
	litMessage,
	now,
	railOpen,
	selectedMessage,
	sessionsById,
	subagentsById,
} from "./state.ts";
import { relativeTime } from "./time.ts";

export function nodeName(ref: NodeRef): string {
	if (ref.kind === "session")
		return sessionsById.value.get(ref.id)?.name ?? "Unknown session";
	const agent = subagentsById.value.get(ref.id);
	return agent ? agent.type : "Unknown agent";
}

export function Rail() {
	const messages = [...(board.value?.messages ?? [])].sort(
		(a, b) => b.at - a.at,
	);
	const open = railOpen.value;
	return (
		<aside class={`rail${open ? " open" : ""}`} aria-label="Messages">
			<button
				type="button"
				class="rail-head"
				onClick={() => {
					railOpen.value = !open;
				}}
				aria-expanded={open}
			>
				<MessagesSquare size={15} aria-hidden="true" />
				<span class="rail-title">Messages</span>
				<span class="rail-count num">{messages.length}</span>
				<span class="rail-toggle">
					{open ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
				</span>
			</button>
			{open && (
				<div class="rail-body" data-scrollable>
					{messages.length === 0 ? (
						<p class="rail-empty">
							No messages yet. When one session messages another, it shows up
							here and travels along an arc on the board.
						</p>
					) : (
						<ul class="messages">
							{messages.map((m) => (
								<li key={m.id}>
									<button
										type="button"
										class={`message${litMessage.value === m.id ? " lit" : ""}`}
										aria-pressed={selectedMessage.value === m.id}
										onMouseEnter={() => {
											hoveredMessage.value = m.id;
										}}
										onMouseLeave={() => {
											hoveredMessage.value = null;
										}}
										onClick={() => {
											selectedMessage.value =
												selectedMessage.value === m.id ? null : m.id;
										}}
									>
										<span class="message-route">
											<span class="message-name">{nodeName(m.from)}</span>
											<span class="message-arrow" aria-hidden="true">
												→
											</span>
											<span class="message-name">{nodeName(m.to)}</span>
											<time class="message-time num">
												{relativeTime(m.at, now.value)}
											</time>
										</span>
										<span class="message-summary">{m.summary}</span>
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</aside>
	);
}
