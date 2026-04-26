/**
 * Initial Sync Direction Modal.
 *
 * Shown on first connection when the plugin needs to know whether
 * to pull remote files into the vault, push local files to remote,
 * or cancel.
 */

import { App, Modal } from "obsidian";
import { InitialSyncDirection } from "../types";

export class InitialSyncModal extends Modal {
	private resolve: (direction: InitialSyncDirection) => void;
	private hasLocalFiles: boolean;
	private hasRemoteFiles: boolean;

	constructor(
		app: App,
		hasLocalFiles: boolean,
		hasRemoteFiles: boolean,
	) {
		super(app);
		this.hasLocalFiles = hasLocalFiles;
		this.hasRemoteFiles = hasRemoteFiles;
		this.resolve = () => {};
	}

	openAndWait(): Promise<InitialSyncDirection> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("glc-initial-sync-modal");

		contentEl.createEl("h2", { text: "First-time sync" });

		const desc: string[] = [];
		if (this.hasRemoteFiles && this.hasLocalFiles) {
			desc.push(
				"Both the remote repository and the local vault subfolder contain files.",
				"Choose how to proceed:",
			);
		} else if (this.hasRemoteFiles) {
			desc.push(
				"The remote repository contains markdown files.",
				"The local vault subfolder is empty.",
			);
		} else if (this.hasLocalFiles) {
			desc.push(
				"The local vault subfolder contains markdown files.",
				"The remote repository is empty (or the configured subfolder has no .md files).",
			);
		} else {
			desc.push("Both the remote and local subfolder are empty. Nothing to sync yet.");
		}

		for (const line of desc) {
			contentEl.createEl("p", { text: line });
		}

		const actions = contentEl.createDiv("glc-initial-sync-actions");

		if (this.hasRemoteFiles) {
			const pullBtn = actions.createEl("button", {
				cls: "mod-cta glc-action-btn",
				text: "Pull remote files to vault",
			});
			pullBtn.addEventListener("click", () => {
				this.resolve(InitialSyncDirection.PULL_REMOTE);
				this.close();
			});
		}

		if (this.hasLocalFiles) {
			const pushBtn = actions.createEl("button", {
				cls: "mod-cta glc-action-btn",
				text: "Push local files to GitLab",
			});
			pushBtn.addEventListener("click", () => {
				this.resolve(InitialSyncDirection.PUSH_LOCAL);
				this.close();
			});
		}

		const cancelBtn = actions.createEl("button", {
			cls: "glc-action-btn",
			text: "Cancel",
		});
		cancelBtn.addEventListener("click", () => {
			this.resolve(InitialSyncDirection.CANCEL);
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
		// Default to cancel if closed without choosing
		this.resolve(InitialSyncDirection.CANCEL);
	}
}
