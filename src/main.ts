/**
 * GitLab Connector — Obsidian Plugin
 *
 * Syncs markdown files between an Obsidian vault subfolder and a GitLab repository.
 * Primary backend: isomorphic-git (offline-capable).
 * Fallback backend: GitLab REST API (lightweight, network-required).
 */

import { Notice, Plugin } from "obsidian";
import type { GitLabConnectorSettings } from "./settings/settings";
import { DEFAULT_SETTINGS } from "./settings/settings";
import { GitLabConnectorSettingsTab } from "./settings/settings-tab";
import { SyncMode, SyncTrigger } from "./types";
import {
	FILE_CHANGE_DEBOUNCE_MS,
	PLUGIN_DISPLAY_NAME,
} from "./constants";

// Sync layer
import { SyncEngine } from "./sync/sync-engine";
import { StateManager } from "./sync/state-manager";
import type { SyncBackend } from "./sync/sync-backend";
import { GitSyncBackend } from "./sync/git-sync-backend";
import { ApiSyncBackend } from "./sync/api-sync-backend";
import type { GitManagerConfig } from "./git/git-manager";
import { wipeFs } from "./git/fs-adapter";

// UI
import { SyncStatusDisplay } from "./ui/sync-status";
import { ensureTrailingSlash } from "./utils/path";

export default class GitLabConnectorPlugin extends Plugin {
	settings!: GitLabConnectorSettings;
	private syncEngine: SyncEngine | null = null;
	private stateManager: StateManager | null = null;
	private statusDisplay: SyncStatusDisplay | null = null;
	private autoSyncInterval: number | null = null;
	private fileChangeDebounceTimer: number | null = null;
	private initialized = false;

	// ── Lifecycle ────────────────────────────────────────────

	async onload(): Promise<void> {
		await this.loadSettings();

		// Settings tab
		this.addSettingTab(new GitLabConnectorSettingsTab(this.app, this));

		// Status display
		this.statusDisplay = new SyncStatusDisplay(this);

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
			id: "init",
			name: "Initialize connection",
			callback: () => this.executeInit(),
		});

		// Ribbon icon — triggers full sync
		this.addRibbonIcon("git-branch", `${PLUGIN_DISPLAY_NAME}: Sync`, () => {
			this.executeFullSync();
		});
	}

	onunload(): void {
		this.teardownAutoSync();
		this.syncEngine = null;
		this.stateManager = null;
	}

	// ── Settings ────────────────────────────────────────────

	async loadSettings(): Promise<void> {
		const data = await this.loadData();
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			data?.settings ?? {},
		);
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
			return true;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.statusDisplay?.update("error", msg);
			new Notice(`${PLUGIN_DISPLAY_NAME}: Initialization failed — ${msg}`);
			return false;
		}
	}

	private createBackend(): SyncBackend {
		if (this.settings.syncMode === SyncMode.ISOMORPHIC_GIT) {
			const remoteUrl = this.buildRemoteUrl();
			const config: GitManagerConfig = {
				remoteUrl,
				branch: this.settings.branch,
				token: this.settings.personalAccessToken,
				depth: this.settings.cloneDepth,
				authorName: this.settings.authorName,
				authorEmail: this.settings.authorEmail,
			};
			return new GitSyncBackend(config, this.settings.remoteSubfolder);
		} else {
			return new ApiSyncBackend(
				this.settings.gitlabUrl,
				this.settings.personalAccessToken,
				this.settings.projectPath,
				this.settings.branch,
				this.settings.remoteSubfolder,
			);
		}
	}

	private buildRemoteUrl(): string {
		const base = this.settings.gitlabUrl.replace(/\/+$/, "");
		const project = this.settings.projectPath;
		return `${base}/${project}.git`;
	}

	private isConfigured(): boolean {
		return !!(
			this.settings.gitlabUrl &&
			this.settings.personalAccessToken &&
			this.settings.projectPath &&
			this.settings.branch
		);
	}

	// ── Sync commands ───────────────────────────────────────

	private async executeInit(): Promise<void> {
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
		if (this.fileChangeDebounceTimer !== null) {
			window.clearTimeout(this.fileChangeDebounceTimer);
		}
		this.fileChangeDebounceTimer = window.setTimeout(() => {
			this.fileChangeDebounceTimer = null;
			this.executePush();
		}, FILE_CHANGE_DEBOUNCE_MS);
	}

	private isInSyncFolder(path: string): boolean {
		if (!this.settings.vaultSubfolder) return true;
		const prefix = ensureTrailingSlash(this.settings.vaultSubfolder);
		return path.startsWith(prefix);
	}

	// ── Public helpers (used by settings tab) ───────────────

	/** Reset the local git repository (wipe LightningFS and re-clone). */
	async resetGitRepo(): Promise<void> {
		await wipeFs();
		this.initialized = false;
		this.syncEngine = null;
		this.stateManager = null;
	}
}
