export function Mark(props: { size?: number }) {
	const size = props.size ?? 20;
	return (
		<svg
			class="mark"
			width={size}
			height={size}
			viewBox="0 0 32 32"
			aria-hidden="true"
		>
			<rect width="32" height="32" rx="8" fill="var(--accent)" />
			<rect
				x="7"
				y="8"
				width="7.5"
				height="16"
				rx="2"
				fill="var(--on-accent)"
			/>
			<rect
				x="17.5"
				y="8"
				width="7.5"
				height="7"
				rx="2"
				fill="var(--on-accent)"
			/>
			<rect
				x="17.5"
				y="17.5"
				width="7.5"
				height="6.5"
				rx="2"
				fill="var(--on-accent)"
				opacity="0.6"
			/>
		</svg>
	);
}
