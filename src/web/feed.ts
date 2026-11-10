import { effect, signal } from "@preact/signals";
import { type Board, type BoardFeed, hasLanded } from "../shared/types.ts";
import { butlerPresence } from "./butler.ts";
import { butlerEdges } from "./butlerEdges.ts";
import { withButlerSubagents } from "./butlerSubagents.ts";
import { receiveColours } from "./colours.ts";
import { receiveComment, receiveComments } from "./comments.ts";
import { digests } from "./digests.ts";
import { docIndex, docStores } from "./docState.ts";
import { receiveExit } from "./exits.ts";
import { receiveIgnores } from "./ignoreState.ts";
import { lastRuns } from "./lastRuns.ts";
import { receiveNotifications } from "./notificationState.ts";
import { noteServerBuild } from "./pageBuild.ts";
import { regions } from "./regionState.ts";
import { relations } from "./relationState.ts";
import {
	forgetAskingReports,
	receiveReport,
	regionReportKey,
} from "./reports.ts";
import { runners } from "./runners.ts";
import {
	annotations,
	awaitingLanding,
	board,
	connection,
	layout,
	openSession,
} from "./state.ts";
import { showSubagents, withSubagentsShown } from "./subagentSetting.ts";
import { usage } from "./usage.ts";

const attemptsBeforeLost = 4;

/** The board as the server last sent it, before Butler's cards' subagents and the Show subagents setting. */
const latest = signal<Board | null>(null);

effect(() => {
	const sent = latest.value;
	if (!sent) return;
	board.value = withSubagentsShown(
		withButlerSubagents(sent, annotations.value),
		showSubagents.value,
	);
});

function feedUrl(): string {
	const scheme = location.protocol === "https:" ? "wss:" : "ws:";
	return `${scheme}//${location.host}/api/feed`;
}

function receive(frame: BoardFeed): void {
	if (frame.type === "hello") {
		noteServerBuild(frame.build);
		return;
	}
	if (frame.type === "board") {
		latest.value = frame.board;
		const landing = awaitingLanding.value;
		const created = landing
			? frame.board.sessions.find((s) => hasLanded(landing, s))
			: undefined;
		if (created) {
			awaitingLanding.value = null;
			openSession(created.id);
		}
		return;
	}
	if (frame.type === "layout") {
		layout.value = frame.layout;
		return;
	}
	if (frame.type === "annotations") {
		annotations.value = frame.annotations;
		return;
	}
	if (frame.type === "colours") {
		receiveColours(frame.colours);
		return;
	}
	if (frame.type === "last-runs") {
		lastRuns.value = frame.lastRuns;
		return;
	}
	if (frame.type === "ignores") {
		receiveIgnores(frame.ignores);
		return;
	}
	if (frame.type === "notifications") {
		receiveNotifications(frame.notifications);
		return;
	}
	if (frame.type === "regions") {
		regions.value = frame.regions;
		return;
	}
	if (frame.type === "exit") {
		receiveExit(frame.sessionId, frame.result);
		return;
	}
	if (frame.type === "report") {
		receiveReport(frame.sessionId, frame.result);
		return;
	}
	if (frame.type === "region-report") {
		receiveReport(regionReportKey(frame.regionId), frame.result);
		return;
	}
	if (frame.type === "comments") {
		receiveComments(frame.comments);
		return;
	}
	if (frame.type === "usage") {
		usage.value = frame.usage;
		return;
	}
	if (frame.type === "digests") {
		digests.value = frame.digests;
		return;
	}
	if (frame.type === "relations") {
		relations.value = frame.relations;
		return;
	}
	if (frame.type === "docs") {
		docIndex.value = frame.docs;
		docStores.value = frame.stores;
		return;
	}
	if (frame.type === "butler") {
		butlerPresence.value = frame.butler;
		return;
	}
	if (frame.type === "butler-edges") {
		butlerEdges.value = frame.edges;
		return;
	}
	if (frame.type === "runners") {
		runners.value = frame.runners;
		return;
	}
	receiveComment(frame.comment);
}

export function connectFeed(): void {
	let attempt = 0;
	const open = () => {
		const socket = new WebSocket(feedUrl());
		socket.addEventListener("open", () => {
			attempt = 0;
			connection.value = "open";
			forgetAskingReports();
		});
		socket.addEventListener("message", (event) => {
			if (typeof event.data !== "string") return;
			try {
				receive(JSON.parse(event.data) as BoardFeed);
			} catch {}
		});
		socket.addEventListener("close", () => {
			connection.value =
				attempt >= attemptsBeforeLost ? "lost" : "reconnecting";
			const delay =
				Math.min(15_000, 500 * 2 ** attempt) * (0.75 + Math.random() / 2);
			attempt += 1;
			setTimeout(open, delay);
		});
	};
	open();
}
