import "@fontsource-variable/inter/wght.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "./styles.css";
import { render } from "preact";
import { App } from "./App.tsx";
import { approvalsOpen } from "./Approvals.tsx";
import { openEdge } from "./butlerEdges.ts";
import { startFocusReports } from "./butlerFocus.ts";
import { openThreadCard } from "./butlerThreads.ts";
import { view } from "./Canvas.tsx";
import { openThreadId } from "./comments.ts";
import { openDoc } from "./docState.ts";
import { connectFeed } from "./feed.ts";
import { notificationsOpen } from "./notificationState.ts";
import {
	keepAcrossReload,
	restoreKept,
	startPageBuildWatch,
} from "./pageBuild.ts";
import { openReport } from "./ReportView.tsx";
import { focusedSessionId, focusedSubagentId, railView } from "./state.ts";
import "./theme.ts";
import "./keyboard.ts";

// Kept across a reload for a new build: the viewport, the open card and the open panels.
keepAcrossReload("view", view);
for (const [name, box] of Object.entries({
	focusedSessionId,
	focusedSubagentId,
	railView,
	openThreadId,
	openThreadCard,
	approvalsOpen,
	notificationsOpen,
	openReport,
	openDoc,
	openEdge,
})) {
	keepAcrossReload(name, box);
}
restoreKept();
startPageBuildWatch();
connectFeed();

const root = document.getElementById("app");
if (root) render(<App />, root);
startFocusReports();

// Installed on a phone or tablet, the board opens to an offline page when the
// Mac can't be reached; the worker caches the app shell and never board data.
if ("serviceWorker" in navigator && window.isSecureContext) {
	navigator.serviceWorker.register("sw.js").catch(() => {});
}
