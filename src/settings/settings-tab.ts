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
import { GitLabClient, GitLabApiError } from "../api/gitlab-client";

export class GitLabConnectorSettingsTab extends PluginSettingTab {
	plugin: GitLabConnectorPlugin;

	constructor(app: App, plugin: GitLabConnectorPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// ── Connection ──────────────────────────────────────
		containerEl.createEl("h2", { text: "Connection" });

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
			.setName("Personal Access Token")
			.setDesc(
				"A GitLab PAT with read_repository and write_repository scopes (git mode), or api/read_api scope (REST API mode). Stored securely using Obsidian's secret storage.",
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text.inputEl.autocomplete = "off";
				text
					.setPlaceholder("glpat-xxxxxxxxxxxx")
					.setValue(this.plugin.app.secretStorage.getSecret(PAT_SECRET_KEY) ?? "")
					.onChange((value) => {
						// Write directly to SecretStorage; PAT is not part of plugin settings
						this.plugin.app.secretStorage.setSecret(PAT_SECRET_KEY, value.trim());
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

		new Setting(containerEl)
			.setName("Branch")
			.setDesc("The branch to sync with.")
			.addText((text) =>
				text
					.setPlaceholder("main")
					.setValue(this.plugin.settings.branch)
					.onChange(async (value) => {
						this.plugin.settings.branch = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		// ── Sync scope ──────────────────────────────────────
		containerEl.createEl("h2", { text: "Sync Scope" });

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

		// ── Sync behaviour ──────────────────────────────────
		containerEl.createEl("h2", { text: "Sync Behaviour" });

		new Setting(containerEl)
			.setName("Sync mode")
			.setDesc(
				"isomorphic-git: full git operations, supports offline commits. REST API: lightweight, requires network for every operation.",
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
			containerEl.createEl("h2", { text: "Git Options" });

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
		containerEl.createEl("h2", { text: "Commit Author" });

		new Setting(containerEl)
			.setName("Author name")
			.setDesc("Name used in git commits.")
			.addText((text) =>
				text
					.setPlaceholder("Your Name")
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

	private async validateConnection(): Promise<void> {
		const { gitlabUrl, projectPath } = this.plugin.settings;
		const personalAccessToken =
			this.plugin.app.secretStorage.getSecret(PAT_SECRET_KEY) ?? "";

		console.debug("[GitLab Connector] validateConnection", {
			gitlabUrl,
			projectPath,
			tokenPresent: personalAccessToken.length > 0,
			tokenLength: personalAccessToken.length,
		});

		if (!gitlabUrl || !personalAccessToken) {
			new Notice("Please enter both the GitLab URL and a Personal Access Token.");
			return;
		}
		if (!projectPath) {
			new Notice("Please enter a project path to test the connection.");
			return;
		}

		try {
			const client = new GitLabClient(gitlabUrl, personalAccessToken, projectPath);
			await client.validateAccess();
			new Notice("Connection successful! Repository is accessible.");
		} catch (err) {
			if (err instanceof GitLabApiError && err.isAuthError) {
				new Notice(
					"Authentication failed. Check your token and ensure it has read_repository scope.",
				);
			} else {
				const msg =
					err instanceof Error ? err.message : String(err);
				new Notice(`Connection failed: ${msg}`);
			}
		}
	}
}
