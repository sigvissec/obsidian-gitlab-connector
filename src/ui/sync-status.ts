/**
 * Sync status display.
 *
 * Desktop: status bar item at the bottom of the window.
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
	private plugin: Plugin;
	private statusBarEl: HTMLElement | null = null;
	private currentState: SyncStatusState = "idle";

	constructor(plugin: Plugin) {
		this.plugin = plugin;
		if (!isMobile()) {
			this.statusBarEl = plugin.addStatusBarItem();
			this.update("idle");
		}
	}

	/** Update the displayed state. */
	update(state: SyncStatusState, detail?: string): void {
		this.currentState = state;

		if (this.statusBarEl) {
			this.statusBarEl.textContent = this.formatStatus(state, detail);
		}

		// On mobile, show a Notice for non-idle states
		if (isMobile() && state !== "idle") {
			new Notice(this.formatNotice(state, detail), state === "error" ? 8000 : 4000);
		}
	}

	/** Show a transient message (always uses Notice). */
	notify(message: string, durationMs = 4000): void {
		new Notice(`${PLUGIN_DISPLAY_NAME}: ${message}`, durationMs);
	}

	private formatStatus(state: SyncStatusState, detail?: string): string {
		const prefix = "GitLab";
		switch (state) {
			case "idle":
				return `${prefix}: Ready`;
			case "syncing":
				return detail ? `${prefix}: ${detail}` : `${prefix}: Syncing...`;
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
					: `${PLUGIN_DISPLAY_NAME}: Syncing...`;
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
