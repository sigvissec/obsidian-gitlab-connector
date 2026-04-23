/**
 * Sync status display.
 *
 * Desktop: status bar item at the bottom of the window showing state + branch.
 *          Clickable — triggers the branch picker menu.
 * Mobile: Notice toasts (status bar is not available on mobile).
 */

import { Notice, Plugin } from "obsidian";
import { isMobile } from "../utils/platform";
import { PLUGIN_DISPLAY_NAME } from "../constants";

export type SyncStatusState =
	| "idle"
	| "syncing"
	| "success"
	| "error"
	| "offline";

export class SyncStatusDisplay {
	private statusBarEl: HTMLElement | null = null;
	private currentState: SyncStatusState = "idle";
	private currentDetail: string | undefined;
	private currentBranch: string | null = null;
	private clickHandler: ((evt: MouseEvent) => void) | null = null;

	constructor(plugin: Plugin) {
		if (!isMobile()) {
			this.statusBarEl = plugin.addStatusBarItem();
			this.statusBarEl.addClass("mod-clickable");
			this.statusBarEl.title = "GitLab connector — click to switch branch";
			this.statusBarEl.addEventListener("click", (evt) => {
				this.clickHandler?.(evt);
			});
			this.renderDom();
		}
	}

	/** Set the click handler invoked when the user clicks the status bar item. */
	setClickHandler(cb: (evt: MouseEvent) => void): void {
		this.clickHandler = cb;
	}

	/** Update the displayed sync state. */
	update(state: SyncStatusState, detail?: string): void {
		this.currentState = state;
		this.currentDetail = detail;
		this.renderDom();

		// On mobile, show a Notice for non-idle states
		if (isMobile() && state !== "idle") {
			new Notice(this.formatNotice(state, detail), state === "error" ? 8000 : 4000);
		}
	}

	/** Update the branch shown next to the status text. Pass null to hide it. */
	setBranch(branch: string | null): void {
		this.currentBranch = branch;
		this.renderDom();
	}

	/** Show a transient message (always uses Notice). */
	notify(message: string, durationMs = 4000): void {
		new Notice(`${PLUGIN_DISPLAY_NAME}: ${message}`, durationMs);
	}

	// ── Private ──────────────────────────────────────────────

	private renderDom(): void {
		const el = this.statusBarEl;
		if (!el) return;

		el.empty();

		el.createSpan({
			cls: "glc-status-text",
			text: this.formatStatus(this.currentState, this.currentDetail),
		});

		if (this.currentBranch) {
			el.createSpan({ cls: "glc-status-branch", text: this.currentBranch });
		}
	}

	private formatStatus(state: SyncStatusState, detail?: string): string {
		const prefix = "GitLab";
		switch (state) {
			case "idle":
				return `${prefix}: Ready`;
			case "syncing":
				return detail ? `${prefix}: ${detail}` : `${prefix}: Syncing…`;
			case "success":
				return `${prefix}: Synced`;
			case "error":
				return detail ? `${prefix}: ${detail}` : `${prefix}: Error`;
			case "offline":
				return `${prefix}: Offline`;
		}
	}

	private formatNotice(state: SyncStatusState, detail?: string): string {
		switch (state) {
			case "syncing":
				return detail
					? `${PLUGIN_DISPLAY_NAME}: ${detail}`
					: `${PLUGIN_DISPLAY_NAME}: Syncing…`;
			case "success":
				return detail
					? `${PLUGIN_DISPLAY_NAME}: ${detail}`
					: `${PLUGIN_DISPLAY_NAME}: Sync complete.`;
			case "error":
				return detail
					? `${PLUGIN_DISPLAY_NAME}: ${detail}`
					: `${PLUGIN_DISPLAY_NAME}: Sync failed.`;
			case "offline":
				return `${PLUGIN_DISPLAY_NAME}: You are offline.`;
			default:
				return `${PLUGIN_DISPLAY_NAME}: ${state}`;
		}
	}
}
