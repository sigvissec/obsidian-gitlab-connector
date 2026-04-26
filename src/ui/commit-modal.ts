/**
 * Commit & Push Modal.
 *
 * Shows all locally-changed files as a checkbox list, lets the user
 * select which files to include, enter a commit message, and confirm
 * the push. Returns the user's selection or null if cancelled.
 */

import { App, Modal } from "obsidian";
import type { FileChange, CommitSelection } from "../types";
import { ChangeType } from "../types";

export class CommitModal extends Modal {
	private changes: FileChange[];
	private defaultMessage: string;
	private resolve: (result: CommitSelection | null) => void;
	private resolved = false;

	constructor(app: App, changes: FileChange[], defaultMessage: string) {
		super(app);
		this.changes = changes;
		this.defaultMessage = defaultMessage;
		this.resolve = () => {};
	}

	/** Open the modal and return a promise that resolves with the user's selection. */
	openAndWait(): Promise<CommitSelection | null> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		this.modalEl.addClass("glc-commit-modal");
		this.render();
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
		if (!this.resolved) {
			this.resolved = true;
			this.resolve(null);
		}
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();

		// ── Header ──────────────────────────────────────────
		contentEl.createEl("h2", { text: "Commit & push" });
		contentEl.createEl("p", {
			cls: "glc-commit-subtitle",
			text: `${this.changes.length} local change(s) detected. Select files to include.`,
		});

		// ── File list ────────────────────────────────────────
		const fileList = contentEl.createDiv("glc-commit-file-list");
		const checkboxes: HTMLInputElement[] = [];

		for (const change of this.changes) {
			const row = fileList.createDiv("glc-commit-file-row");

			const checkbox = row.createEl("input", { type: "checkbox" });
			checkbox.checked = true;
			checkbox.addEventListener("change", () => updateButton());
			checkboxes.push(checkbox);

			const badgeCls =
				change.type === ChangeType.CREATED
					? "glc-badge-created"
					: change.type === ChangeType.DELETED
						? "glc-badge-deleted"
						: "glc-badge-modified";
			row.createEl("span", { cls: `glc-badge ${badgeCls}`, text: change.type });

			row.createEl("span", { cls: "glc-commit-filepath", text: change.path });
		}

		// ── Select All / Deselect All ────────────────────────
		const selectionRow = contentEl.createDiv("glc-commit-selection-row");
		const selectAllBtn = selectionRow.createEl("button", {
			cls: "glc-link-btn",
			text: "Select all",
		});
		selectionRow.createEl("span", { text: " · " });
		const deselectAllBtn = selectionRow.createEl("button", {
			cls: "glc-link-btn",
			text: "Deselect all",
		});

		selectAllBtn.addEventListener("click", () => {
			checkboxes.forEach((cb) => (cb.checked = true));
			updateButton();
		});
		deselectAllBtn.addEventListener("click", () => {
			checkboxes.forEach((cb) => (cb.checked = false));
			updateButton();
		});

		// ── Commit message ───────────────────────────────────
		contentEl.createEl("label", {
			cls: "glc-commit-label",
			text: "Commit message",
		});
		const textarea = contentEl.createEl("textarea", {
			cls: "glc-commit-message",
		});
		textarea.value = this.defaultMessage;
		textarea.rows = 3;
		textarea.addEventListener("input", () => updateButton());

		// ── Action buttons ───────────────────────────────────
		const actions = contentEl.createDiv("glc-commit-actions");

		const cancelBtn = actions.createEl("button", {
			cls: "glc-action-btn",
			text: "Cancel",
		});
		cancelBtn.addEventListener("click", () => this.close());

		const pushBtn = actions.createEl("button", {
			cls: "mod-cta glc-action-btn",
			text: "Commit & push",
		});
		pushBtn.addEventListener("click", () => {
			const selected = this.changes.filter((_, i) => checkboxes[i].checked);
			const message = textarea.value.trim();
			if (selected.length === 0 || !message) return;
			this.resolved = true;
			this.resolve({ changes: selected, message });
			this.close();
		});

		const updateButton = () => {
			const anyChecked = checkboxes.some((cb) => cb.checked);
			const hasMessage = textarea.value.trim().length > 0;
			pushBtn.disabled = !anyChecked || !hasMessage;
		};

		// Set initial button state
		updateButton();
	}
}
