export const maxSchedules = 20;
export const maxSchedulePrompt = 4000;
export const defaultScheduleTime = "08:00";
export const maxHistoryDays = 30;

export const defaultReportPrompt = [
	"Report on everything that ran since the last report.",
	"For each session active in that window, say what it did, what landed, what is still running, what failed and what is waiting on me.",
	"Start with what needs me, then failures, then what is still running, then what landed or finished. Keep each session to a line or two and name it as the board does.",
].join(" ");

const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const isScheduleTime = (value: unknown): value is string =>
	typeof value === "string" && timePattern.test(value);

const slotOn = (day: Date, time: string): Date => {
	const [hours, minutes] = time.split(":").map(Number);
	const slot = new Date(day);
	slot.setHours(hours ?? 0, minutes ?? 0, 0, 0);
	return slot;
};

export const lastSlotAtOrBefore = (now: number, time: string): number => {
	const today = slotOn(new Date(now), time);
	if (today.getTime() <= now) return today.getTime();
	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	return slotOn(yesterday, time).getTime();
};
