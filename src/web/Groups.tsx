import { Folder } from "lucide-preact";
import type { Group } from "./groups.ts";

export function GroupFrames(props: { groups: readonly Group[] }) {
	return (
		<>
			{props.groups.map((group) => (
				<div
					key={group.key}
					class="group-frame"
					style={{
						transform: `translate(${group.frame.x}px, ${group.frame.y}px)`,
						width: `${group.frame.w}px`,
						height: `${group.frame.h}px`,
					}}
					title={group.cwd}
				>
					<span class="group-label">
						<Folder size={12} aria-hidden="true" />
						{group.project}
					</span>
				</div>
			))}
		</>
	);
}
