/**
 * Create Branch Modal.
 *
 * Prompts the user for a new branch name and the base branch to create
 * it from. The branch is created locally only — it is pushed to the
 * remote on the next push, not immediately.
 */

import { App, Modal, Notice } from "obsidian";

export interface NewBranchChoice {
	name: string;
	base: string;
}

/** Validate a branch name against the common git rules. */
export function isValidBranchName(name: string): boolean {
	if (!name) return false;
	if (name.startsWith("/") || name.endsWith("/")) return false;
	if (name.startsWith("-") || name.startsWith(".")) return false;
	if (name.endsWith(".lock")) return false;
	if (name.includes("..") || name.includes("//")) return false;
	if (name.includes("@{")) return false;
	// Forbidden chars: whitespace, ~ ^ : ? * [ \ and control chars
	if (/[\s~^:?*\[\\\x00-\x1f\x7f]/.test(name)) return false;
	return true;
}

export class CreateBranchModal extends Modal {
	private branches: string[];
	private defaultBase: string;
	private resolve: (choice: NewBranchChoice | null) => void = () => {};
	private resolved = false;

	constructor(app: App, branches: string[], defaultBase: string) {
		super(app);
		this.branches = branches;
		this.defaultBase = defaultBase;
	}

	openAndWait(): Promise<NewBranchChoice | null> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("glc-create-branch-modal");

		contentEl.createEl("h2", { text: "Create New Branch" });
		contentEl.createEl("p", {
			text:
				"Creates the branch locally and switches to it. The branch is" +
				" published to GitLab on your next push.",
		});

		const nameLabel = contentEl.createEl("label", {
			cls: "glc-field-label",
			text: "Branch name",
		});
		const nameInput = nameLabel.createEl("input", {
			type: "text",
			cls: "glc-field-input",
			placeholder: "feature/my-branch",
		});

		const baseLabel = contentEl.createEl("label", {
			cls: "glc-field-label",
			text: "Base branch",
		});
		const baseSelect = baseLabel.createEl("select", {
			cls: "glc-field-input",
		});
		if (this.branches.length === 0) {
			baseSelect.createEl("option", {
				value: this.defaultBase,
				text: this.defaultBase,
			});
		} else {
			for (const b of this.branches) {
				const opt = baseSelect.createEl("option", {
					value: b,
					text: b,
				});
				if (b === this.defaultBase) opt.selected = true;
			}
		}

		const actions = contentEl.createDiv("glc-create-branch-actions");

		const createBtn = actions.createEl("button", {
			cls: "mod-cta glc-action-btn",
			text: "Create",
		});
		const cancelBtn = actions.createEl("button", {
			cls: "glc-action-btn",
			text: "Cancel",
		});

		const submit = () => {
			const name = nameInput.value.trim();
			if (!isValidBranchName(name)) {
				new Notice("Invalid branch name.");
				nameInput.focus();
				return;
			}
			this.resolved = true;
			this.resolve({ name, base: baseSelect.value });
			this.close();
		};

		createBtn.addEventListener("click", submit);
		cancelBtn.addEventListener("click", () => {
			this.resolved = true;
			this.resolve(null);
			this.close();
		});
		nameInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				submit();
			}
		});

		nameInput.focus();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.resolved) {
			this.resolved = true;
			this.resolve(null);
		}
	}
}
