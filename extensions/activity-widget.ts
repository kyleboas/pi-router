import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { DelegateActivityEvent } from "./orchestrator.js";

interface ActivityState extends DelegateActivityEvent {
	startedAt: number;
	finishedAt?: number;
	lastMessage?: string;
}

export class DelegateActivityWidget {
	private readonly activities = new Map<string, ActivityState>();

	update(event: DelegateActivityEvent, ctx: ExtensionContext): void {
		const previous = this.activities.get(event.delegateId);
		if (event.phase === "start") {
			this.activities.set(event.delegateId, { ...event, startedAt: Date.now() });
		} else if (previous) {
			this.activities.set(event.delegateId, {
				...previous,
				...event,
				lastMessage: event.message ?? previous.lastMessage,
				finishedAt: event.phase === "finish" ? Date.now() : previous.finishedAt,
			});
		}
		if (typeof ctx.ui.setWidget === "function") ctx.ui.setWidget("pi-router-delegates", this.render(ctx));
	}

	clear(ctx?: ExtensionContext): void {
		this.activities.clear();
		if (ctx && typeof ctx.ui.setWidget === "function") ctx.ui.setWidget("pi-router-delegates", undefined);
	}

	render(ctx: ExtensionContext): string[] {
		const active = [...this.activities.values()].filter((activity) => activity.phase !== "finish").length;
		return [
			ctx.ui.theme.fg("accent", `Delegates (${active} active)`),
			...[...this.activities.values()].map((activity) => {
				const icon = activity.phase === "finish" ? (activity.ok ? "✓" : "✗") : "●";
				const coloredIcon =
					activity.phase !== "finish"
						? ctx.ui.theme.fg("accent", icon)
						: activity.ok
							? ctx.ui.theme.fg("success", icon)
							: ctx.ui.theme.fg("error", icon);
				const detail = activity.lastMessage ? ` · ${activity.lastMessage.replace(/^Worker:\s*/, "")}` : "";
				const task = activity.task.replace(/\s+/g, " ").trim();
				const preview = task.length > 72 ? `${task.slice(0, 71)}…` : task;
				return `${coloredIcon} ${activity.worker} · ${activity.model}${detail}\n  ${ctx.ui.theme.fg("muted", preview)}`;
			}),
		].flatMap((line) => line.split("\n"));
	}
}
