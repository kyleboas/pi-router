import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { DelegateActivityWidget } from "../extensions/activity-widget.js";

function context() {
	const setWidget = vi.fn();
	return {
		setWidget,
		ctx: {
			ui: {
				setWidget,
				theme: { fg: (_color: string, text: string) => text },
			},
		} as unknown as ExtensionContext,
	};
}

describe("DelegateActivityWidget", () => {
	it("shows running progress and completion above the editor", () => {
		const widget = new DelegateActivityWidget();
		const { ctx, setWidget } = context();
		const base = {
			delegateId: "d-1",
			worker: "small" as const,
			model: "provider/small:low",
			task: "Run the focused verification suite",
		};
		widget.update({ phase: "start", ...base }, ctx);
		expect(setWidget).toHaveBeenLastCalledWith(
			"pi-router-delegates",
			expect.arrayContaining(["Delegates (1 active)", expect.stringContaining("● small")]),
		);
		widget.update({ phase: "progress", message: "Worker: bash", ...base }, ctx);
		expect(setWidget).toHaveBeenLastCalledWith(
			"pi-router-delegates",
			expect.arrayContaining([expect.stringContaining("· bash")]),
		);
		widget.update({ phase: "finish", ok: true, ...base }, ctx);
		expect(setWidget).toHaveBeenLastCalledWith(
			"pi-router-delegates",
			expect.arrayContaining(["Delegates (0 active)", expect.stringContaining("✓ small")]),
		);
		widget.clear(ctx);
		expect(setWidget).toHaveBeenLastCalledWith("pi-router-delegates", undefined);
	});
});
