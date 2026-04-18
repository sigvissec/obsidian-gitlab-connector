/**
 * GitLab Connector — Obsidian Plugin
 *
 * Syncs markdown files between an Obsidian vault subfolder and a GitLab repository.
 * Primary backend: isomorphic-git (offline-capable).
 * Fallback backend: GitLab REST API (lightweight, network-required).
 */

import { Menu, Notice, Plugin } from "obsidian";
import { GitLabClient } from "./api/gitlab-client";
import type { GitLabConnectorSettings } from "./settings/settings";
import { DEFAULT_SETTINGS } from "./settings/settings";
import { GitLabConnectorSettingsTab } from "./settings/settings-tab";
import { SyncMode, SyncTrigger } from "./types";
import {
	FILE_CHANGE_DEBOUNCE_MS,
	PAT_SECRET_KEY,
	PLUGIN_DISPLAY_NAME,
} from "./constants";

// Sync layer
import { SyncEngine } from "./sync/sync-engine";
import { StateManager, clearAllSyncState } from "./sync/state-manager";
import type { SyncBackend } from "./sync/sync-backend";
import { GitSyncBackend } from "./sync/git-sync-backend";
import { ApiSyncBackend } from "./sync/api-sync-backend";
import type { GitManagerConfig } from "./git/git-manager";
import { wipeFs } from "./git/fs-adapter";

// UI
import { SyncStatusDisplay } from "./ui/sync-status";
import { CreateBranchModal } from "./ui/create-branch-modal";
import { ensureTrailingSlash } from "./utils/path";

export default class GitLabConnectorPlugin extends Plugin {
	settings!: GitLabConnectorSettings;
	private syncEngine: SyncEngine | null = null;
	private stateManager: StateManager | null = null;
	private statusDisplay: SyncStatusDisplay | null = null;
	private autoSyncInterval: number | null = null;
	private fileChangeDebounceTimer: number | null = null;
	private initialized = false;
	private unloading = false;
	/** Branch list fetched from GitLab for the status-bar branch picker menu. */
	private cachedBranches: string[] = [];

	// ── Lifecycle ────────────────────────────────────────────

	async onload(): Promise<void> {
		await this.loadSettings();

		// Settings tab
		this.addSettingTab(new GitLabConnectorSettingsTab(this.app, this));

		// Status display
		this.statusDisplay = new SyncStatusDisplay(this);
		this.statusDisplay.setClickHandler((evt) => this.showBranchMenu(evt));

		// Commands
		this.addCommand({
			id: "pull",
			name: "Pull from remote",
			callback: () => this.executePull(),
		});

		this.addCommand({
			id: "push",
			name: "Push to remote",
			callback: () => this.executePush(),
		});

		this.addCommand({
			id: "sync",
			name: "Full sync",
			callback: () => this.executeFullSync(),
		});

		this.addCommand({
			id: "commit-push",
			name: "Commit and push selected files",
			callback: () => this.executeCommitAndPush(),
		});

		this.addCommand({
			id: "init",
			name: "Initialize connection",
			callback: () => this.executeInit(),
		});

		// Ribbon icon — opens a menu with all sync operations
		this.addRibbonIcon("git-branch", PLUGIN_DISPLAY_NAME, (evt: MouseEvent) => {
			const menu = new Menu();
			menu.addItem((item) =>
				item.setTitle("Pull").setIcon("download").onClick(() => this.executePull()),
			);
			menu.addItem((item) =>
				item.setTitle("Push").setIcon("upload").onClick(() => this.executePush()),
			);
			menu.addItem((item) =>
				item.setTitle("Full Sync").setIcon("refresh-cw").onClick(() => this.executeFullSync()),
			);
			menu.addItem((item) =>
				item
					.setTitle("Commit & Push Selected Files")
					.setIcon("git-commit")
					.onClick(() => this.executeCommitAndPush()),
			);
			menu.addItem((item) =>
				item
					.setTitle("Switch Branch")
					.setIcon("git-branch-plus")
					.onClick((evt) => this.showBranchMenu(evt as MouseEvent)),
			);
			menu.addSeparator();
			menu.addItem((item) =>
				item.setTitle("Re-initialize").setIcon("rotate-ccw").onClick(() => this.executeInit()),
			);
			menu.showAtMouseEvent(evt);
		});
	}

	onunload(): void {
		this.unloading = true;
		this.teardownAutoSync();
		this.syncEngine = null;
		this.stateManager = null;
	}

	// ── Settings ────────────────────────────────────────────

	async loadSettings(): Promise<void> {
		const data = await this.loadData();
		const rawSettings = { ...(data?.settings ?? {}) };

		// One-time migration: if a plaintext PAT exists in data.json, move it to SecretStorage
		const legacyPat = (rawSettings as Record<string, unknown>).personalAccessToken as string | undefined;
		if (legacyPat) {
			this.app.secretStorage.setSecret(PAT_SECRET_KEY, legacyPat);
			delete (rawSettings as Record<string, unknown>).personalAccessToken;
			const cleaned = data ?? {};
			cleaned.settings = rawSettings;
			await this.saveData(cleaned);
		}

		this.settings = Object.assign({}, DEFAULT_SETTINGS, rawSettings);
	}

	async saveSettings(): Promise<void> {
		const allData = (await this.loadData()) ?? {};
		allData.settings = this.settings;
		await this.saveData(allData);

		// If the sync engine is active, re-apply settings
		if (this.syncEngine) {
			this.syncEngine.setSettings(this.settings);
		}

		// Reconfigure auto-sync if trigger changed
		this.setupAutoSync();
	}

	/**
	 * Called by Obsidian when data.json is modified externally
	 * (e.g. by Obsidian Sync from another device).
	 */
	async onExternalSettingsChange(): Promise<void> {
		await this.loadSettings();
		if (this.syncEngine) {
			this.syncEngine.setSettings(this.settings);
		}
	}

	// ── Initialisation ──────────────────────────────────────

	private async ensureInitialized(): Promise<boolean> {
		if (this.initialized && this.syncEngine) {
			return true;
		}

		if (!this.isConfigured()) {
			new Notice(
				`${PLUGIN_DISPLAY_NAME}: Please configure the plugin in Settings first.`,
			);
			return false;
		}

		try {
			this.statusDisplay?.update("syncing", "Initializing...");

			// Create backend based on current mode
			const backend = this.createBackend();

			// Create state manager (each mode has its own state)
			const modeKey =
				this.settings.syncMode === SyncMode.ISOMORPHIC_GIT
					? "git"
					: "api";
			this.stateManager = new StateManager(this, modeKey);
			await this.stateManager.load();

			// Create sync engine
			this.syncEngine = new SyncEngine(
				this.app,
				backend,
				this.stateManager,
				this.settings,
				() => this.saveSettings(),
			);

			// Initialise backend (may trigger clone / first-sync modal)
			const ok = await this.syncEngine.initialize();
			if (!ok) {
				this.statusDisplay?.update("idle");
				return false;
			}

			this.initialized = true;
			this.setupAutoSync();
			this.statusDisplay?.update("success", "Connected");
			// Update branch chip and pre-load branch list for the picker menu
			void this.refreshStatusBranch();
			void this.prefetchBranches();
			return true;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.statusDisplay?.update("error", msg);
			new Notice(`${PLUGIN_DISPLAY_NAME}: Initialization failed — ${msg}`);
			return false;
		}
	}

	private createBackend(): SyncBackend {
		const token = this.app.secretStorage.getSecret(PAT_SECRET_KEY) ?? "";
		if (this.settings.syncMode === SyncMode.ISOMORPHIC_GIT) {
			const remoteUrl = this.buildRemoteUrl();
			const config: GitManagerConfig = {
				remoteUrl,
				branch: this.settings.branch,
				workingBranch: this.settings.workingBranch || this.settings.branch,
				token,
				depth: this.settings.cloneDepth,
				authorName: this.settings.authorName,
				authorEmail: this.settings.authorEmail,
			};
			return new GitSyncBackend(config, this.settings.remoteSubfolder);
		} else {
			return new ApiSyncBackend(
				this.settings.gitlabUrl,
				token,
				this.settings.projectPath,
				this.settings.branch,
				this.settings.workingBranch || this.settings.branch,
				this.settings.remoteSubfolder,
			);
		}
	}

	private buildRemoteUrl(): string {
		const base = this.settings.gitlabUrl.replace(/\/+$/, "");
		if (!/^https:\/\//i.test(base)) {
			throw new Error(
				"GitLab URL must use HTTPS to protect your Personal Access Token.",
			);
		}
		const project = this.settings.projectPath;
		if (!/^[\w\-./]+$/.test(project)) {
			throw new Error(
				"Invalid project path. Only alphanumeric characters, hyphens, underscores, dots, and forward slashes are allowed.",
			);
		}
		return `${base}/${project}.git`;
	}

	private isConfigured(): boolean {
		const token = this.app.secretStorage.getSecret(PAT_SECRET_KEY);
		return !!(
			this.settings.gitlabUrl &&
			token &&
			this.settings.projectPath &&
			this.settings.branch
		);
	}

	// ── Sync commands ───────────────────────────────────────

	private async executeInit(): Promise<void> {
		try {
			this.statusDisplay?.update("syncing", "Resetting...");
			// Wipe the local git repository so it will be re-cloned with current settings
			await wipeFs();
			// Clear persisted sync state so the first-sync modal appears again
			await clearAllSyncState(this);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.statusDisplay?.update("error", msg);
			new Notice(`${PLUGIN_DISPLAY_NAME}: Reset failed — ${msg}`);
			return;
		}
		this.initialized = false;
		this.syncEngine = null;
		this.stateManager = null;
		await this.ensureInitialized();
	}

	private async executePull(): Promise<void> {
		if (!(await this.ensureInitialized())) return;
		if (this.syncEngine!.isSyncing()) {
			new Notice(`${PLUGIN_DISPLAY_NAME}: Sync already in progress.`);
			return;
		}

		try {
			this.statusDisplay?.update("syncing", "Pulling...");
			await this.syncEngine!.pull();
			this.statusDisplay?.update("success", "Pull complete");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.statusDisplay?.update("error", msg);
			new Notice(`${PLUGIN_DISPLAY_NAME}: Pull failed — ${msg}`);
		}
	}

	private async executePush(): Promise<void> {
		if (!(await this.ensureInitialized())) return;
		if (this.syncEngine!.isSyncing()) {
			new Notice(`${PLUGIN_DISPLAY_NAME}: Sync already in progress.`);
			return;
		}

		try {
			this.statusDisplay?.update("syncing", "Pushing...");
			await this.syncEngine!.push();
			this.statusDisplay?.update("success", "Push complete");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.statusDisplay?.update("error", msg);
			new Notice(`${PLUGIN_DISPLAY_NAME}: Push failed — ${msg}`);
		}
	}

	private async executeCommitAndPush(): Promise<void> {
		if (!(await this.ensureInitialized())) return;
		if (this.syncEngine!.isSyncing()) {
			new Notice(`${PLUGIN_DISPLAY_NAME}: Sync already in progress.`);
			return;
		}

		try {
			this.statusDisplay?.update("syncing", "Staging...");
			await this.syncEngine!.pushWithSelection();
			this.statusDisplay?.update("success", "Push complete");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.statusDisplay?.update("error", msg);
			new Notice(`${PLUGIN_DISPLAY_NAME}: Push failed — ${msg}`);
		}
	}

	private async executeFullSync(): Promise<void> {
		if (!(await this.ensureInitialized())) return;
		if (this.syncEngine!.isSyncing()) {
			new Notice(`${PLUGIN_DISPLAY_NAME}: Sync already in progress.`);
			return;
		}

		try {
			this.statusDisplay?.update("syncing", "Syncing...");
			await this.syncEngine!.fullSync();
			this.statusDisplay?.update("success", "Sync complete");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.statusDisplay?.update("error", msg);
			new Notice(`${PLUGIN_DISPLAY_NAME}: Sync failed — ${msg}`);
		}
	}

	// ── Auto-sync ───────────────────────────────────────────

	private setupAutoSync(): void {
		this.teardownAutoSync();

		if (this.settings.syncTrigger === SyncTrigger.AUTO_TIMER) {
			const intervalMs =
				this.settings.syncIntervalMinutes * 60 * 1000;
			this.autoSyncInterval = this.registerInterval(
				window.setInterval(() => {
					this.executeFullSync();
				}, intervalMs),
			) as unknown as number;
		}

		if (this.settings.syncTrigger === SyncTrigger.FILE_CHANGE) {
			// Watch for vault file changes in the sync subfolder
			this.registerEvent(
				this.app.vault.on("modify", (file) => {
					if (this.isInSyncFolder(file.path)) {
						this.debouncedPush();
					}
				}),
			);
			this.registerEvent(
				this.app.vault.on("create", (file) => {
					if (this.isInSyncFolder(file.path)) {
						this.debouncedPush();
					}
				}),
			);
			this.registerEvent(
				this.app.vault.on("delete", (file) => {
					if (this.isInSyncFolder(file.path)) {
						this.debouncedPush();
					}
				}),
			);
			this.registerEvent(
				this.app.vault.on("rename", (file, oldPath) => {
					if (
						this.isInSyncFolder(file.path) ||
						this.isInSyncFolder(oldPath)
					) {
						this.debouncedPush();
					}
				}),
			);
		}
	}

	private teardownAutoSync(): void {
		if (this.autoSyncInterval !== null) {
			window.clearInterval(this.autoSyncInterval);
			this.autoSyncInterval = null;
		}
		if (this.fileChangeDebounceTimer !== null) {
			window.clearTimeout(this.fileChangeDebounceTimer);
			this.fileChangeDebounceTimer = null;
		}
	}

	private debouncedPush(): void {
		if (this.unloading) return;
		if (this.fileChangeDebounceTimer !== null) {
			window.clearTimeout(this.fileChangeDebounceTimer);
		}
		this.fileChangeDebounceTimer = window.setTimeout(() => {
			this.fileChangeDebounceTimer = null;
			if (this.unloading) return;
			this.executePush();
		}, FILE_CHANGE_DEBOUNCE_MS);
	}

	private isInSyncFolder(path: string): boolean {
		if (!this.settings.vaultSubfolder) return true;
		const prefix = ensureTrailingSlash(this.settings.vaultSubfolder);
		return path.startsWith(prefix);
	}

	// ── Branch picker (status bar) ──────────────────────────

	private showBranchMenu(evt: MouseEvent): void {
		const current = this.settings.workingBranch || this.settings.branch;
		const menu = new Menu();

		if (this.cachedBranches.length === 0) {
			// Branches not loaded yet — offer to load them
			menu.addItem((item) =>
				item
					.setTitle(`Current: ${current}`)
					.setIcon("git-branch")
					.setDisabled(true),
			);
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle("Load branches from GitLab…")
					.setIcon("refresh-cw")
					.onClick(async () => {
						await this.prefetchBranches();
						new Notice(
							`${PLUGIN_DISPLAY_NAME}: Branches loaded — click the status bar to switch.`,
						);
					}),
			);
		} else {
			for (const branch of this.cachedBranches) {
				const isCurrent = branch === current;
				menu.addItem((item) =>
					item
						.setTitle(branch)
						.setIcon("git-branch")
						.setChecked(isCurrent)
						.onClick(async () => {
							if (!isCurrent) await this.switchWorkingBranch(branch);
						}),
				);
			}
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle("Create new branch…")
					.setIcon("git-branch-plus")
					.onClick(async () => {
						await this.promptCreateNewBranch();
					}),
			);
			menu.addItem((item) =>
				item
					.setTitle("Refresh branch list")
					.setIcon("refresh-cw")
					.onClick(async () => {
						await this.prefetchBranches();
					}),
			);
		}

		menu.showAtMouseEvent(evt);
	}

	/** Prompt the user for a new branch name and base, then create it locally. */
	private async promptCreateNewBranch(): Promise<void> {
		const defaultBase = this.settings.workingBranch || this.settings.branch;
		const modal = new CreateBranchModal(
			this.app,
			this.cachedBranches,
			defaultBase,
		);
		const choice = await modal.openAndWait();
		if (!choice) return;
		if (this.cachedBranches.includes(choice.name)) {
			new Notice(
				`${PLUGIN_DISPLAY_NAME}: Branch '${choice.name}' already exists — switch to it instead.`,
			);
			return;
		}
		await this.createNewWorkingBranch(choice.name, choice.base);
	}

	/**
	 * Create a new working branch locally, based on the given base branch.
	 * Updates settings, wipes the local repo, clears state, and re-initializes.
	 * The branch is not pushed to the remote until the user commits and pushes.
	 */
	private async createNewWorkingBranch(
		name: string,
		base: string,
	): Promise<void> {
		try {
			this.statusDisplay?.update("syncing", `Creating ${name}…`);
			this.settings.branch = base;
			this.settings.workingBranch = name;
			await this.saveSettings();
			await wipeFs();
			await clearAllSyncState(this);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.statusDisplay?.update("error", msg);
			new Notice(`${PLUGIN_DISPLAY_NAME}: Branch create failed — ${msg}`);
			return;
		}
		this.initialized = false;
		this.syncEngine = null;
		this.stateManager = null;
		await this.ensureInitialized();
		// Add the new branch to the cached list so the user sees it highlighted
		if (!this.cachedBranches.includes(name)) {
			this.cachedBranches = [...this.cachedBranches, name].sort();
		}
		new Notice(
			`${PLUGIN_DISPLAY_NAME}: Created '${name}' locally — push to publish it to GitLab.`,
		);
	}

	/** Update the branch chip in the status bar from the actual local HEAD. */
	private async refreshStatusBranch(): Promise<void> {
		const branch = await this.getLocalBranch();
		this.statusDisplay?.setBranch(branch);
	}

	/** Fetch the remote branch list into cachedBranches (best-effort, silent on error). */
	private async prefetchBranches(): Promise<void> {
		if (!this.isConfigured()) return;
		try {
			const token = this.app.secretStorage.getSecret(PAT_SECRET_KEY) ?? "";
			const client = new GitLabClient(
				this.settings.gitlabUrl,
				token,
				this.settings.projectPath,
			);
			const branches = await client.listBranches();
			this.cachedBranches = branches.map((b) => b.name).sort();
		} catch {
			// Non-critical — branch list simply stays empty / stale
		}
	}

	/** Switch the working branch, clear state, and re-initialize. */
	private async switchWorkingBranch(branch: string): Promise<void> {
		try {
			this.statusDisplay?.update("syncing", `Switching to ${branch}…`);
			this.settings.workingBranch = branch;
			await this.saveSettings();
			await wipeFs();
			await clearAllSyncState(this);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.statusDisplay?.update("error", msg);
			new Notice(`${PLUGIN_DISPLAY_NAME}: Branch switch failed — ${msg}`);
			return;
		}
		this.initialized = false;
		this.syncEngine = null;
		this.stateManager = null;
		await this.ensureInitialized();
	}

	// ── Public helpers (used by settings tab) ───────────────

	/**
	 * Return the branch currently checked out in the local git repository.
	 * In REST API mode returns the working branch setting (no local repo).
	 * Returns null if not yet initialized.
	 */
	async getLocalBranch(): Promise<string | null> {
		if (!this.initialized || !this.syncEngine) return null;
		try {
			const backend = this.syncEngine.getBackend();
			if (backend instanceof GitSyncBackend) {
				return await backend.getGitManager().getCurrentBranch();
			}
			// REST API mode — no local git repo; show the working branch setting
			return this.settings.workingBranch || this.settings.branch;
		} catch {
			return null;
		}
	}

	/** Reset the local git repository (wipe LightningFS and re-clone). */
	async resetGitRepo(): Promise<void> {
		await wipeFs();
		this.initialized = false;
		this.syncEngine = null;
		this.stateManager = null;
	}
}
