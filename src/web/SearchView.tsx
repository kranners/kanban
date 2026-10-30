import { Search } from "lucide-preact";
import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { ActivityIcon, activityLabel } from "./activity.tsx";
import { board, openSession, search, sessionMatches } from "./state.ts";

export function SearchView(): JSX.Element {
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => input.current?.focus({ preventScroll: true }), []);
	const query = search.value.trim();
	const sessions = board.value?.sessions ?? [];
	const matches = query ? sessions.filter(sessionMatches) : [];
	return (
		<div class="search-view">
			<label class="search">
				<Search size={14} aria-hidden="true" />
				<input
					ref={input}
					type="search"
					placeholder="Search sessions"
					value={search.value}
					onInput={(event) => {
						search.value = event.currentTarget.value;
					}}
					onKeyDown={(event) => {
						if (event.key === "Escape" && search.value) {
							event.stopPropagation();
							search.value = "";
						}
					}}
					aria-label="Search sessions"
				/>
			</label>
			{!query ? (
				<p class="rail-empty">
					Search by name, project, folder or what a session is doing. Sessions
					that don't match fade on the board.
				</p>
			) : matches.length === 0 ? (
				<p class="rail-empty">No sessions match “{query}”.</p>
			) : (
				<>
					<p class="rail-section num" aria-live="polite">
						{matches.length} of {sessions.length} sessions
					</p>
					<ul class="search-results">
						{matches.map((session) => (
							<li key={session.id}>
								<button
									type="button"
									class={`search-result act-${session.activity}`}
									title={activityLabel[session.activity]}
									onClick={(event) =>
										openSession(
											session.id,
											event.currentTarget.getBoundingClientRect(),
										)
									}
								>
									<span class="search-result-head">
										<ActivityIcon activity={session.activity} size={11} />
										<span class="search-result-name">{session.name}</span>
										<span class="search-result-project">{session.project}</span>
									</span>
									{session.doing && (
										<span class="search-result-doing">{session.doing}</span>
									)}
								</button>
							</li>
						))}
					</ul>
				</>
			)}
		</div>
	);
}
