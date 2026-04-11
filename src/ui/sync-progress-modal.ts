/**
 * Sync Progress Modal.
 *
 * Shown during long-running operations (initial clone, large sync).
 * Displays a progress message and an optional cancel button.
 */

import { App, Modal } from "obsidian";

export class SyncProgressModal extends Modal {
	private messageEl!: HTMLElement;
	private detailEl!: HTMLElement;
	private cancelled = false;

	constructor(app: App) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("glc-progress-modal");

		contentEl.createEl("h2", { text: "Syncing..." });

		this.messageEl = contentEl.createEl("div", {
			cls: "glc-progress-message",
			text: "Initialising...",
		});
		this.detailEl = contentEl.createEl("div", {
			cls: "glc-progress-detail",
		});

		const cancelBtn = contentEl.createEl("button", {
			cls: "glc-action-btn",
			text: "Cancel",
		});
		cancelBtn.addEventListener("click", () => {
			this.cancelled = true;
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/** Update the progress message. */
	setMessage(message: string): void {
		if (this.messageEl) {
			this.messageEl.textContent = message;
		}
	}

	/** Update the detail line (e.g., current file name). */
	setDetail(detail: string): void {
		if (this.detailEl) {
			this.detailEl.textContent = detail;
		}
	}

	/** Whether the user clicked Cancel. */
	isCancelled(): boolean {
		return this.cancelled;
	}
}
