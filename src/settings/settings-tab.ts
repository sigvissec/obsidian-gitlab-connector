/**
 * Settings tab for the GitLab Connector plugin.
 *
 * Provides all user-configurable options: connection details,
 * sync scope, sync behaviour, git options, and author info.
 */

import {
	App,
	Notice,
	PluginSettingTab,
	Setting,
} from "obsidian";
import type GitLabConnectorPlugin from "../main";
import { SyncMode, SyncTrigger } from "../types";
import {
	MIN_SYNC_INTERVAL_MINUTES,
	MAX_SYNC_INTERVAL_MINUTES,
	MIN_CLONE_DEPTH,
	MAX_CLONE_DEPTH,
	PAT_SECRET_KEY,
	PLUGIN_DISPLAY_NAME,
} from "../constants";
import { GitLabClient } from "../api/gitlab-client";

export class GitLabConnectorSettingsTab extends PluginSettingTab {
	plugin: GitLabConnectorPlugin;

	/** Branches fetched from GitLab for the dropdown/datalist. */
	private cachedBranches: string[] = [];
	private fetchingBranches = false;

	constructor(app: App, plugin: GitLabConnectorPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// ── Connection ──────────────────────────────────────
		new Setting(containerEl).setName("Connection").setHeading();

		new Setting(containerEl)
			.setName("GitLab URL")
			.setDesc("Base URL of your GitLab instance.")
			.addText((text) =>
				text
					.setPlaceholder("https://gitlab.com")
					.setValue(this.plugin.settings.gitlabUrl)
					.onChange(async (value) => {
						this.plugin.settings.gitlabUrl = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Personal access token")
			.setDesc(
				"A GitLab PAT with read_repository and write_repository scopes (git mode), or api/read_api scope (REST API mode). Stored securely using Obsidian's secret storage.",
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text.inputEl.autocomplete = "off";
				const hasToken = !!(this.plugin.app.secretStorage.getSecret(PAT_SECRET_KEY));
				text
					.setPlaceholder(hasToken ? "Token saved — enter new value to replace" : "glpat-xxxxxxxxxxxx")
					.setValue("")
					.onChange((value) => {
						if (value.trim()) {
							this.plugin.app.secretStorage.setSecret(PAT_SECRET_KEY, value.trim());
						}
					});
			});

		new Setting(containerEl)
			.setName("Validate connection")
			.setDesc("Test that the URL and token are correct.")
			.addButton((btn) =>
				btn.setButtonText("Test").onClick(async () => {
					await this.validateConnection();
				}),
			);

		new Setting(containerEl)
			.setName("Project path")
			.setDesc(
				'Full path to the GitLab project (e.g. "my-group/my-repo") or the numeric project ID.',
			)
			.addText((text) =>
				text
					.setPlaceholder("user/repository")
					.setValue(this.plugin.settings.projectPath)
					.onChange(async (value) => {
						this.plugin.settings.projectPath = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		// ── Branches ────────────────────────────────────────
		new Setting(containerEl).setName("Branches").setHeading();

		// Fetch branches action
		new Setting(containerEl)
			.setName("Load branches from GitLab")
			.setDesc(
				"Fetch available branches to enable dropdown selection. Requires URL, token, and project path to be configured.",
			)
			.addButton((btn) => {
				btn
					.setButtonText(this.fetchingBranches ? "Loading…" : "Fetch branches")
					.setDisabled(this.fetchingBranches)
					.onClick(async () => {
						await this.fetchBranches();
					});
			});

		// Branch (source) — dropdown when branches are loaded, text otherwise
		const branchSetting = new Setting(containerEl)
			.setName("Branch")
			.setDesc(
				"Remote branch to read from when pulling. Acts as the base when creating the working branch.",
			);

		if (this.cachedBranches.length > 0) {
			branchSetting.addDropdown((dd) => {
				const options = [...this.cachedBranches];
				// Ensure current value is always present even if not on remote
				if (!options.includes(this.plugin.settings.branch)) {
					options.unshift(this.plugin.settings.branch);
				}
				for (const b of options) dd.addOption(b, b);
				dd.setValue(this.plugin.settings.branch).onChange(async (value) => {
					this.plugin.settings.branch = value;
					await this.plugin.saveSettings();
				});
			});
		} else {
			branchSetting.addText((text) =>
				text
					.setPlaceholder("main")
					.setValue(this.plugin.settings.branch)
					.onChange(async (value) => {
						this.plugin.settings.branch = value.trim();
						await this.plugin.saveSettings();
					}),
			);
		}

		// Working branch — text input with branch-list autocomplete when loaded
		const workingBranchSetting = new Setting(containerEl)
			.setName("Working branch")
			.setDesc(
				"Branch that local changes are pushed to. Created automatically from the source branch if it does not exist. Set to the same value as the source branch to push directly.",
			);

		workingBranchSetting.addText((text) => {
			// Attach a <datalist> for autocomplete when branches are available
			if (this.cachedBranches.length > 0) {
				const listId = "glc-branch-datalist";
				const datalist = text.inputEl.doc.createElement("datalist");
				datalist.id = listId;
				for (const b of this.cachedBranches) {
					const opt = datalist.createEl("option");
					opt.value = b;
				}
				// Insert next to the input so it's cleaned up with containerEl
				text.inputEl.after(datalist);
				text.inputEl.setAttribute("list", listId);
			}
			text
				.setPlaceholder("obsidian-plugin")
				.setValue(this.plugin.settings.workingBranch)
				.onChange(async (value) => {
					this.plugin.settings.workingBranch = value.trim();
					await this.plugin.saveSettings();
				});
		});

		// Show the currently checked-out local branch
		const localBranchSetting = new Setting(containerEl)
			.setName("Currently checked out")
			.setDesc("Reading…");

		this.plugin.getLocalBranch().then((branch) => {
			if (!localBranchSetting.settingEl.isConnected) return; // tab closed
			localBranchSetting.setDesc(
				branch ?? "Not initialized — run initialize connection first",
			);
		}).catch(() => {
			if (!localBranchSetting.settingEl.isConnected) return;
			localBranchSetting.setDesc("Not available");
		});

		// ── Sync scope ──────────────────────────────────────
		new Setting(containerEl).setName("Sync scope").setHeading();

		new Setting(containerEl)
			.setName("Remote subfolder")
			.setDesc(
				'Subfolder inside the GitLab repo to sync. Leave empty to sync from the repo root. Example: "notes/".',
			)
			.addText((text) =>
				text
					.setPlaceholder("")
					.setValue(this.plugin.settings.remoteSubfolder)
					.onChange(async (value) => {
						this.plugin.settings.remoteSubfolder = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Vault subfolder")
			.setDesc(
				'Subfolder inside your vault where synced files will live. Example: "gitlab-notes".',
			)
			.addText((text) =>
				text
					.setPlaceholder("gitlab-notes")
					.setValue(this.plugin.settings.vaultSubfolder)
					.onChange(async (value) => {
						this.plugin.settings.vaultSubfolder = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Show hidden directories")
			.setDesc(
				"Remap dot-prefixed remote directories (.github/, .agents/, …) to " +
				"underscore-prefixed names (_github/, _agents/, …) so Obsidian's " +
				"file explorer shows them. The mapping is built automatically on the " +
				"first pull that discovers each hidden directory. Push transparently " +
				"reverses the rename. Disable if your remote has directories that " +
				"intentionally start with an underscore and should not be remapped.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.remapHiddenDirs)
					.onChange(async (value) => {
						this.plugin.settings.remapHiddenDirs = value;
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		const dotDirMap = this.plugin.settings.dotDirMap;
		if (
			this.plugin.settings.remapHiddenDirs &&
			Object.keys(dotDirMap).length > 0
		) {
			const mapSetting = new Setting(containerEl)
				.setName("Discovered directory mappings")
				.setDesc(
					"Remote → vault directory name substitutions discovered during pulls.",
				);
			const list = mapSetting.settingEl.createDiv({
				cls: "glc-dir-map-list",
			});
			for (const [remote, vault] of Object.entries(dotDirMap)) {
				list.createDiv({
					cls: "glc-dir-map-entry",
					text: `${remote}/ → ${vault}/`,
				});
			}

			new Setting(containerEl)
				.setName("Clear directory mapping")
				.setDesc(
					"Remove all entries. The map will be rebuilt automatically on the next pull.",
				)
				.addButton((btn) =>
					btn
						.setButtonText("Clear")
						.setWarning()
						.onClick(async () => {
							this.plugin.settings.dotDirMap = {};
							await this.plugin.saveSettings();
							this.display();
						}),
				);
		}

		// ── Sync behaviour ──────────────────────────────────
		new Setting(containerEl).setName("Sync behaviour").setHeading();

		new Setting(containerEl)
			.setName("Sync mode")
			.setDesc(
				"isomorphic-git: full git operations, supports offline commits (not recommended on mobile — clones the entire repo into device storage). REST API: lightweight, stateless, recommended for mobile and Android.",
			)
			.addDropdown((dd) =>
				dd
					.addOption(SyncMode.ISOMORPHIC_GIT, "isomorphic-git (offline capable)")
					.addOption(SyncMode.REST_API, "REST API (lightweight)")
					.setValue(this.plugin.settings.syncMode)
					.onChange(async (value) => {
						this.plugin.settings.syncMode = value as SyncMode;
						await this.plugin.saveSettings();
						// Re-render to show/hide git-specific settings
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName("Sync trigger")
			.setDesc("How sync operations are initiated.")
			.addDropdown((dd) =>
				dd
					.addOption(SyncTrigger.MANUAL, "Manual only")
					.addOption(
						SyncTrigger.FILE_CHANGE,
						"On file change (debounced)",
					)
					.addOption(SyncTrigger.AUTO_TIMER, "Automatic interval")
					.setValue(this.plugin.settings.syncTrigger)
					.onChange(async (value) => {
						this.plugin.settings.syncTrigger =
							value as SyncTrigger;
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		if (this.plugin.settings.syncTrigger === SyncTrigger.AUTO_TIMER) {
			new Setting(containerEl)
				.setName("Sync interval (minutes)")
				.setDesc(
					`How often to auto-sync. Range: ${MIN_SYNC_INTERVAL_MINUTES}–${MAX_SYNC_INTERVAL_MINUTES}.`,
				)
				.addSlider((slider) =>
					slider
						.setLimits(
							MIN_SYNC_INTERVAL_MINUTES,
							MAX_SYNC_INTERVAL_MINUTES,
							1,
						)
						.setValue(this.plugin.settings.syncIntervalMinutes)
						.setDynamicTooltip()
						.onChange(async (value) => {
							this.plugin.settings.syncIntervalMinutes = value;
							await this.plugin.saveSettings();
						}),
				);
		}

		// ── Git options (only for isomorphic-git mode) ──────
		if (this.plugin.settings.syncMode === SyncMode.ISOMORPHIC_GIT) {
			new Setting(containerEl).setName("Git options").setHeading();

			new Setting(containerEl)
				.setName("Clone depth")
				.setDesc(
					`Shallow clone depth. Lower values save bandwidth and memory. Range: ${MIN_CLONE_DEPTH}–${MAX_CLONE_DEPTH}.`,
				)
				.addSlider((slider) =>
					slider
						.setLimits(MIN_CLONE_DEPTH, MAX_CLONE_DEPTH, 1)
						.setValue(this.plugin.settings.cloneDepth)
						.setDynamicTooltip()
						.onChange(async (value) => {
							this.plugin.settings.cloneDepth = value;
							await this.plugin.saveSettings();
						}),
				);

			new Setting(containerEl)
				.setName("Reset local repository")
				.setDesc(
					"Delete the local git repository and re-clone on next sync. Use if you encounter corruption.",
				)
				.addButton((btn) =>
					btn
						.setButtonText("Reset")
						.setWarning()
						.onClick(async () => {
							await this.plugin.resetGitRepo();
							new Notice("Local git repository has been reset.");
						}),
				);
		}

		// ── Author info ─────────────────────────────────────
		new Setting(containerEl).setName("Commit author").setHeading();

		new Setting(containerEl)
			.setName("Author name")
			.setDesc("Name used in git commits.")
			.addText((text) =>
				text
					.setPlaceholder("Your name")
					.setValue(this.plugin.settings.authorName)
					.onChange(async (value) => {
						this.plugin.settings.authorName = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Author email")
			.setDesc("Email used in git commits.")
			.addText((text) =>
				text
					.setPlaceholder("you@example.com")
					.setValue(this.plugin.settings.authorEmail)
					.onChange(async (value) => {
						this.plugin.settings.authorEmail = value.trim();
						await this.plugin.saveSettings();
					}),
			);
	}

	// ── Private helpers ─────────────────────────────────────

	private async fetchBranches(): Promise<void> {
		const { gitlabUrl, projectPath } = this.plugin.settings;
		const token = this.plugin.app.secretStorage.getSecret(PAT_SECRET_KEY) ?? "";

		if (!gitlabUrl || !token || !projectPath) {
			new Notice(
				`${PLUGIN_DISPLAY_NAME}: Please configure GitLab URL, personal access token, and project path first.`,
			);
			return;
		}

		this.fetchingBranches = true;
		this.display();

		try {
			const client = new GitLabClient(gitlabUrl, token, projectPath);
			const branches = await client.listBranches();
			this.cachedBranches = branches.map((b) => b.name).sort();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`${PLUGIN_DISPLAY_NAME}: Failed to fetch branches — ${msg}`);
		} finally {
			this.fetchingBranches = false;
			this.display();
		}
	}

	private async validateConnection(): Promise<void> {
		const result = await this.plugin.checkConnection();
		switch (result.kind) {
			case "ok":
				new Notice("Connection successful! Repository is accessible.");
				return;
			case "branch-missing":
				new Notice(
					`Connection successful, but the remote branch "${result.branch}" does not exist in the repository.`,
				);
				return;
			case "missing-credentials":
				new Notice("Please enter both the GitLab URL and a personal access token.");
				return;
			case "missing-project":
				new Notice("Please enter a project path to test the connection.");
				return;
			case "auth-failed":
				new Notice(
					"Authentication failed. Check your token and ensure it has read_repository scope.",
				);
				return;
			case "error":
				new Notice(`Connection failed: ${result.message}`);
				return;
		}
	}
}
