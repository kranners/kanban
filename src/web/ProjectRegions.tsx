import "./projectRegions.css";
import { Eye, EyeOff, Layers, SquareArrowOutUpRight } from "lucide-preact";
import type { JSX } from "preact";
import { stageNames } from "../shared/projects.ts";
import type { Region } from "../shared/types.ts";
import { centreOn } from "./Canvas.tsx";
import { colourOf } from "./colours.ts";
import { groupLabelSpace } from "./placement.ts";
import {
	isFilteredTo,
	type ProjectTile,
	progressOf,
	type TileStatus,
	tileFor,
	tileStatuses,
	tileStatusLabel,
	toggleProjectFilter,
} from "./projectRegions.ts";
import { openProject } from "./projects.ts";
import { setRegionDoneOpen } from "./regionState.ts";
import { now } from "./state.ts";

/** Leaves the region's frame and bar showing around its tile, as the session summaries do. */
const tileEdge = 2;

const shownCounts: readonly TileStatus[] = [
	"working",
	"needs-you",
	"stalled",
	"failed",
];

function Counts(props: {
	tile: ProjectTile;
	only?: readonly TileStatus[];
}): JSX.Element {
	const statuses = props.only ?? tileStatuses;
	return (
		<span class="project-region-counts">
			{statuses.map((status) =>
				props.tile.counts[status] > 0 ? (
					<span
						key={status}
						class={`project-region-count status-${status}`}
						title={tileStatusLabel[status]}
					>
						<span class="num">{props.tile.counts[status]}</span>{" "}
						{tileStatusLabel[status]}
					</span>
				) : null,
			)}
		</span>
	);
}

function Progress(props: { tile: ProjectTile }): JSX.Element | null {
	const share = progressOf(props.tile.project);
	if (share === null) return null;
	return (
		<span
			class="project-region-progress"
			role="progressbar"
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={Math.round(share * 100)}
			aria-label="Progress"
		>
			<span style={{ width: `${Math.round(share * 100)}%` }} />
		</span>
	);
}

/** Where a project stands in a line: its own state, else what it waits on, else its next step. */
const whereAt = (tile: ProjectTile): string => {
	const p = tile.project;
	if (!p) return "Cards no project claims yet; Butler links them.";
	return p.state || (p.blockedOn ? `Waiting on ${p.blockedOn}` : p.next);
};

/** The line under a project region's bar: stage, where it is at, and its controls. */
export function ProjectRegionHeader(props: {
	region: Region;
}): JSX.Element | null {
	const tile = tileFor(props.region, now.value);
	if (!tile) return null;
	const done = tile.counts.done;
	const filtered = isFilteredTo(tile.id);
	return (
		<div class="project-region-header" data-no-pan>
			{tile.project && (
				<span
					class={`project-region-stage stage-${tile.project.stage}`}
					title={`Stage: ${stageNames[tile.project.stage]}`}
				>
					{stageNames[tile.project.stage]}
				</span>
			)}
			<span class="project-region-where" title={whereAt(tile)}>
				{whereAt(tile)}
			</span>
			<Counts tile={tile} only={shownCounts} />
			{done > 0 && (
				<button
					type="button"
					class="project-region-button"
					title={
						props.region.doneOpen
							? "Stack the done cards again"
							: "Spread out the done cards"
					}
					onClick={() =>
						void setRegionDoneOpen(props.region.id, !props.region.doneOpen)
					}
				>
					<Layers size={12} aria-hidden="true" />
					{props.region.doneOpen ? "Stack done" : `+${done} done`}
				</button>
			)}
			<button
				type="button"
				class={`project-region-button${filtered ? " on" : ""}`}
				aria-pressed={filtered}
				title={filtered ? "Show every project" : "Show only this project"}
				onClick={() => toggleProjectFilter(tile.id)}
			>
				{filtered ? (
					<EyeOff size={12} aria-hidden="true" />
				) : (
					<Eye size={12} aria-hidden="true" />
				)}
				{filtered ? "Show all" : "Only this"}
			</button>
			{tile.project && (
				<button
					type="button"
					class="project-region-button"
					title="Open the project in Projects"
					onClick={() => openProject(tile.id)}
				>
					<SquareArrowOutUpRight size={12} aria-hidden="true" />
					Project
				</button>
			)}
		</div>
	);
}

/** A project region zoomed out: one tile of how the project stands. */
function ProjectTileView(props: { region: Region }): JSX.Element | null {
	const { region } = props;
	const tile = tileFor(region, now.value);
	if (!tile) return null;
	const p = tile.project;
	return (
		<div
			class={`summary region region-${colourOf(region.cwd)} project-tile`}
			data-summary={region.id}
			style={{
				transform: `translate(${region.x + tileEdge}px, ${region.y + groupLabelSpace}px)`,
				width: `${region.w - 2 * tileEdge}px`,
				height: `${region.h - groupLabelSpace - tileEdge}px`,
			}}
		>
			<div class="summary-inner project-tile-inner">
				<button
					type="button"
					class="project-tile-head"
					title={`Zoom in on ${tile.title}`}
					onClick={() => centreOn(region)}
				>
					<span class="project-tile-title">{tile.title}</span>
					{p && (
						<span class={`project-region-stage stage-${p.stage}`}>
							{stageNames[p.stage]}
						</span>
					)}
				</button>
				<Counts tile={tile} only={shownCounts} />
				{p?.next && (
					<p class="project-tile-next">
						<span class="project-tile-label">Next</span> {p.next}
					</p>
				)}
				<Progress tile={tile} />
				{p && (
					<button
						type="button"
						class="project-region-button project-tile-open"
						onClick={() => openProject(p.id)}
					>
						<SquareArrowOutUpRight size={12} aria-hidden="true" />
						Open project
					</button>
				)}
			</div>
		</div>
	);
}

/** Butler's project regions as overview tiles, for the zoomed-out board. */
export function ProjectTiles(props: {
	regions: readonly Region[];
}): JSX.Element {
	return (
		<>
			{props.regions.map((region) => (
				<ProjectTileView key={region.id} region={region} />
			))}
		</>
	);
}
