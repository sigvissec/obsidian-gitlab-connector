/**
 * Conflict Resolution Modal.
 *
 * A full-screen modal that guides the user through resolving
 * merge conflicts one file at a time.  Optimised for mobile:
 * unified diff view (not side-by-side), large tap targets,
 * buttons at the bottom.
 */

import { App, Modal } from "obsidian";
import type { ConflictInfo, ResolvedConflict } from "../types";
import { ConflictKind, ConflictResolution } from "../types";
import { renderDiffToContainer, createConflictMarkers } from "../utils/diff";

export class ConflictModal extends Modal {
	private conflicts: ConflictInfo[];
	private currentIndex: number;
	private resolutions: ResolvedConflict[];
	private resolve: (resolutions: ResolvedConflict[]) => void;

	constructor(app: App, conflicts: ConflictInfo[]) {
		super(app);
		this.conflicts = conflicts;
		this.currentIndex = 0;
		this.resolutions = [];
		this.resolve = () => {};
	}

	/**
	 * Open the modal and return a promise that resolves with
	 * the user's resolution choices when all conflicts are handled.
	 */
	openAndWait(): Promise<ResolvedConflict[]> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		this.modalEl.addClass("glc-conflict-modal");
		this.renderCurrentConflict();
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
		// If the user closed without resolving everything,
		// return whatever we have (caller handles incomplete)
		this.resolve(this.resolutions);
	}

	private renderCurrentConflict(): void {
		const { contentEl } = this;
		contentEl.empty();

		const conflict = this.conflicts[this.currentIndex];
		const total = this.conflicts.length;
		const num = this.currentIndex + 1;

		// ── Header ──────────────────────────────────────────
		const header = contentEl.createDiv("glc-conflict-header");
		header.createEl("h2", {
			text: `Conflict ${num} of ${total}`,
		});
		header.createEl("div", {
			cls: "glc-conflict-filename",
			text: conflict.path,
		});

		// ── Context card ────────────────────────────────────
		const ctx = contentEl.createDiv("glc-conflict-context");
		if (conflict.kind === ConflictKind.AUTO_MERGEABLE) {
			ctx.createEl("div", {
				cls: "glc-conflict-auto-badge",
				text: "Auto-merge available — changes do not overlap.",
			});
		} else {
			ctx.createEl("div", {
				cls: "glc-conflict-manual-badge",
				text: "Overlapping changes — manual resolution required.",
			});
		}

		// ── Diff view ───────────────────────────────────────
		const diffContainer = contentEl.createDiv("glc-diff-container");

		// Show local vs remote diff using safe DOM construction
		renderDiffToContainer(
			diffContainer,
			conflict.remoteContent,
			conflict.localContent,
			conflict.path,
		);

		// ── Action buttons ──────────────────────────────────
		const actions = contentEl.createDiv("glc-conflict-actions");

		if (conflict.kind === ConflictKind.AUTO_MERGEABLE) {
			const mergeBtn = actions.createEl("button", {
				cls: "mod-cta glc-action-btn",
				text: "Auto-merge",
			});
			mergeBtn.addEventListener("click", () => {
				this.resolveConflict({
					path: conflict.path,
					resolution: ConflictResolution.USE_MERGED,
					content: conflict.mergedContent,
				});
			});
		}

		const keepMineBtn = actions.createEl("button", {
			cls: "glc-action-btn",
			text: "Keep mine",
		});
		keepMineBtn.addEventListener("click", () => {
			this.resolveConflict({
				path: conflict.path,
				resolution: ConflictResolution.KEEP_LOCAL,
				content: conflict.localContent,
			});
		});

		const keepTheirsBtn = actions.createEl("button", {
			cls: "glc-action-btn",
			text: "Keep theirs",
		});
		keepTheirsBtn.addEventListener("click", () => {
			this.resolveConflict({
				path: conflict.path,
				resolution: ConflictResolution.KEEP_REMOTE,
				content: conflict.remoteContent,
			});
		});

		const editBtn = actions.createEl("button", {
			cls: "glc-action-btn",
			text: "Edit manually",
		});
		editBtn.addEventListener("click", () => {
			this.resolveConflict({
				path: conflict.path,
				resolution: ConflictResolution.EDIT_MANUALLY,
				content: createConflictMarkers(
					conflict.localContent,
					conflict.remoteContent,
				),
			});
		});
	}

	private resolveConflict(resolution: ResolvedConflict): void {
		this.resolutions.push(resolution);

		if (this.currentIndex < this.conflicts.length - 1) {
			this.currentIndex++;
			this.renderCurrentConflict();
		} else {
			// All conflicts resolved
			this.close();
		}
	}
}
