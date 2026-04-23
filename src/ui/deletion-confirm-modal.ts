/**
 * Deletion Confirmation Modal.
 *
 * Shown when files have been deleted on the remote.
 * The user chooses per-file (or bulk) whether to delete locally too
 * or keep the local copy.
 */

import { App, Modal } from "obsidian";

export interface DeletionChoice {
	path: string;
	/** True = delete locally, false = keep local copy. */
	deleteLocally: boolean;
}

export class DeletionConfirmModal extends Modal {
	private paths: string[];
	private resolve: (choices: DeletionChoice[]) => void;

	constructor(app: App, paths: string[]) {
		super(app);
		this.paths = paths;
		this.resolve = () => {};
	}

	openAndWait(): Promise<DeletionChoice[]> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("glc-deletion-modal");

		contentEl.createEl("h2", {
			text: "Files deleted on remote",
		});
		contentEl.createEl("p", {
			text: `${this.paths.length} file(s) were deleted on GitLab. What would you like to do with the local copies?`,
		});

		// File list
		const list = contentEl.createDiv("glc-deletion-list");
		for (const path of this.paths) {
			list.createEl("div", {
				cls: "glc-deletion-item",
				text: path,
			});
		}

		// Bulk action buttons
		const actions = contentEl.createDiv("glc-deletion-actions");

		const keepAllBtn = actions.createEl("button", {
			cls: "glc-action-btn",
			text: "Keep all local copies",
		});
		keepAllBtn.addEventListener("click", () => {
			this.resolve(
				this.paths.map((path) => ({ path, deleteLocally: false })),
			);
			this.close();
		});

		const deleteAllBtn = actions.createEl("button", {
			cls: "mod-warning glc-action-btn",
			text: "Delete all locally",
		});
		deleteAllBtn.addEventListener("click", () => {
			this.resolve(
				this.paths.map((path) => ({ path, deleteLocally: true })),
			);
			this.close();
		});
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
		// If closed without choosing, keep all by default (safe)
		this.resolve(
			this.paths.map((path) => ({ path, deleteLocally: false })),
		);
	}
}
