import type { JSX, SVGAttributes } from "preact";

// Butler's identity on the board: a bow tie on a teal tile, the same
// rounded-rect language as Mark, in --butler instead of the accent so
// he never reads as the app, Aaron or the board agent.

/** The bow tie in the mark's 32-unit space, centred on (16, 16). */
function BowTie(props: { knotOpacity?: number }) {
	return (
		<>
			<path
				d="M12.4 13.9 7 10.6v10.8l5.4-3.3Z M19.6 13.9 25 10.6v10.8l-5.4-3.3Z"
				fill="currentColor"
				stroke="currentColor"
				stroke-width="2"
				stroke-linejoin="round"
			/>
			<rect
				x="14.2"
				y="12.6"
				width="3.6"
				height="6.8"
				rx="1.4"
				fill="currentColor"
				opacity={props.knotOpacity}
			/>
		</>
	);
}

export function ButlerMark(props: { size?: number }) {
	const size = props.size ?? 20;
	return (
		<svg
			class="butler-mark"
			width={size}
			height={size}
			viewBox="0 0 32 32"
			aria-hidden="true"
			style={{ color: "var(--on-butler)" }}
		>
			<rect width="32" height="32" rx="8" fill="var(--butler)" />
			<BowTie knotOpacity={0.6} />
		</svg>
	);
}

/**
 * Presence avatar. From 24px up it is his face, the wink and the monocle
 * over a bow tie; below that the face turns to a blob, so it is the bow
 * tie alone.
 */
export function ButlerAvatar(props: { size?: number; label?: string }) {
	const size = props.size ?? 24;
	return (
		<svg
			class="butler-avatar"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			style={{ color: "var(--on-butler)" }}
			role={props.label ? "img" : undefined}
			aria-label={props.label}
			aria-hidden={props.label ? undefined : "true"}
		>
			<circle cx="12" cy="12" r="12" fill="var(--brass)" />
			<circle cx="12" cy="12" r="10.5" fill="var(--butler)" />
			{size < 24 ? (
				<g transform="translate(12 12) scale(0.6) translate(-16 -16)">
					<BowTie />
				</g>
			) : (
				<>
					<path
						d="M5.6 10.4Q7.9 8.3 10.2 10.4"
						fill="none"
						stroke="currentColor"
						stroke-width="1.75"
						stroke-linecap="round"
					/>
					<circle
						cx="15.6"
						cy="9.8"
						r="2.9"
						fill="none"
						stroke="currentColor"
						stroke-width="1.5"
					/>
					<circle cx="15.6" cy="9.8" r="1.1" fill="currentColor" />
					<g transform="translate(12 17) scale(0.42) translate(-16 -16)">
						<BowTie />
					</g>
				</>
			)}
		</svg>
	);
}

/**
 * A collaborator cursor: the arrow, edged in white so it holds on light
 * and dark cards alike, and a chip naming him. The chip is HTML so it
 * sizes to the label and takes the app's own Inter.
 */
export function ButlerCursor(props: { label?: string }) {
	const label = props.label ?? "Butler";
	return (
		<span
			class="butler-cursor"
			role="img"
			aria-label={label}
			style={{
				display: "inline-flex",
				alignItems: "flex-start",
				pointerEvents: "none",
			}}
		>
			<svg width="20" height="24" viewBox="0 0 20 24" aria-hidden="true">
				<path
					d="M4 3v17l4.6-4.4 3 6.8 2.8-1.2-2.9-6.6h6.1Z"
					fill="var(--butler)"
					stroke="var(--butler-edge)"
					stroke-width="1.6"
					stroke-linejoin="round"
				/>
			</svg>
			<span
				aria-hidden="true"
				style={{
					display: "inline-flex",
					alignItems: "center",
					gap: "5px",
					height: "20px",
					margin: "18px 0 0 -4px",
					padding: "0 8px 0 7px",
					borderRadius: "6px",
					background: "var(--butler)",
					color: "var(--on-butler)",
					font: "600 12px/20px var(--sans)",
					whiteSpace: "nowrap",
				}}
			>
				<svg width="11" height="8" viewBox="5.5 9 21 14" aria-hidden="true">
					<BowTie />
				</svg>
				{label}
			</span>
		</span>
	);
}

type IconProps = Omit<SVGAttributes<SVGSVGElement>, "size" | "color"> & {
	size?: number | string;
	color?: string;
	strokeWidth?: number | string;
	class?: string;
};

/** Lucide's own frame, so these sit beside lucide-preact icons. */
function StrokeIcon({
	name,
	children,
	size = 24,
	color,
	strokeWidth,
	class: cls,
	...rest
}: IconProps & { name: string; children: JSX.Element[] }) {
	const label = rest["aria-label"];
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke={color ?? "currentColor"}
			stroke-width={strokeWidth ?? 2}
			stroke-linecap="round"
			stroke-linejoin="round"
			{...rest}
			class={["lucide", `lucide-${name}`, cls].filter(Boolean).join(" ")}
			role={label ? "img" : undefined}
			aria-label={label}
			aria-hidden={label ? undefined : "true"}
		>
			{children}
		</svg>
	);
}

/** A filled bow tie for the stroke icons, wings apart from the knot so it stays a bow tie at 16px. */
function IconBowTie(props: {
	wings: string;
	knot: { x: number; y: number; width: number; height: number };
	color?: string;
}) {
	const fill = props.color ?? "currentColor";
	return (
		<g fill={fill} stroke={fill} stroke-width="1">
			<path d={props.wings} />
			<rect {...props.knot} rx="0.6" stroke="none" />
		</g>
	);
}

export function SelfFixIcon(props: IconProps) {
	return (
		<StrokeIcon {...props} name="butler-self-fix">
			<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z" />
			<IconBowTie
				color={props.color}
				wings="M15.3 16.6 17 17.6v1.8l-1.7 1z M22.3 16.6 20.6 17.6v1.8l1.7 1z"
				knot={{ x: 18.2, y: 17.2, width: 1.2, height: 2.6 }}
			/>
		</StrokeIcon>
	);
}

export function ButlerNoteIcon(props: IconProps) {
	return (
		<StrokeIcon {...props} name="butler-note">
			<path d="M21 9a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2z" />
			<path d="M15 3v5a1 1 0 0 0 1 1h5" />
			<IconBowTie
				color={props.color}
				wings="M7 12 9.8 13.5v2L7 17z M17 12 14.2 13.5v2L17 17z"
				knot={{ x: 11.3, y: 12.9, width: 1.4, height: 3.2 }}
			/>
		</StrokeIcon>
	);
}

/** An eye behind a monocle, its chain hanging straight down below the lid. */
export function ButlerWatchingIcon(props: IconProps) {
	return (
		<StrokeIcon {...props} name="butler-watching">
			<path d="M2.062 9.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
			<circle cx="12" cy="9" r="3.5" />
			<circle
				cx="12"
				cy="9"
				r="1.25"
				fill={props.color ?? "currentColor"}
				stroke="none"
			/>
			<path d="M12 18.75h0M12 21.75h0" />
		</StrokeIcon>
	);
}
