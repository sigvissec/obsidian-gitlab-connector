/**
 * Sync Engine — the core orchestrator.
 *
 * Coordinates the sync backend, state manager, change tracker,
 * conflict detector, and UI modals into a coherent pull/push/full-sync flow.
 */

import type { App, Vault } from "obsidian";
import { normalizePath, Notice } from "obsidian";
import type { SyncBackend } from "./sync-backend";
import { StateManager, FileSyncState } from "./state-manager";
import { detectChanges, ChangeDetectionResult } from "./change-tracker";
import { classifyConflicts } from "./conflict-detector";
import { sha256 } from "../utils/hash";
import {
	remotePathToVaultPath,
	vaultPathToRemotePath,
	ensureTrailingSlash,
} from "../utils/path";
import { getAllVaultMdFilePaths } from "./file-filter";
import type {
	FileChange,
	ConflictInfo,
	ResolvedConflict,
	PushResult,
	CommitSelection,
} from "../types";
import {
	ChangeType,
	ConflictKind,
	ConflictResolution,
	InitialSyncDirection,
	SyncDirection,
} from "../types";
import { ConflictModal } from "../ui/conflict-modal";
import { CommitModal } from "../ui/commit-modal";
import { DeletionConfirmModal, DeletionChoice } from "../ui/deletion-confirm-modal";
import { InitialSyncModal } from "../ui/initial-sync-modal";
import { SyncProgressModal } from "../ui/sync-progress-modal";
import type { GitLabConnectorSettings } from "../settings/settings";
import { PLUGIN_DISPLAY_NAME } from "../constants";

export class SyncEngine {
	private app: App;
	private vault: Vault;
	private backend: SyncBackend;
	private stateManager: StateManager;
	private settings: GitLabConnectorSettings;
	private syncing = false;
	private saveFn: () => Promise<void>;

	constructor(
		app: App,
		backend: SyncBackend,
		stateManager: StateManager,
		settings: GitLabConnectorSettings,
		saveSettings: () => Promise<void> = async () => {},
	) {
		this.app = app;
		this.vault = app.vault;
		this.backend = backend;
		this.stateManager = stateManager;
		this.settings = settings;
		this.saveFn = saveSettings;
	}

	/** Effective dot-dir map: populated map when remapping is on, empty otherwise. */
	private get effectiveDotDirMap(): Record<string, string> {
		return this.settings.remapHiddenDirs ? this.settings.dotDirMap : {};
	}

	/** Expose the active backend (e.g., for settings tab status display). */
	getBackend(): SyncBackend {
		return this.backend;
	}

	/** Replace the active backend (e.g., when user switches modes). */
	setBackend(backend: SyncBackend): void {
		this.backend = backend;
	}

	/** Replace settings reference (e.g., after settings change). */
	setSettings(settings: GitLabConnectorSettings): void {
		this.settings = settings;
	}

	/** True if a sync operation is in progress. */
	isSyncing(): boolean {
		return this.syncing;
	}

	// ── Public sync operations ──────────────────────────────

	/**
	 * Initialise the backend.  Shows a progress modal during
	 * long operations like the initial clone.
	 *
	 * Returns false if the user cancelled or init failed.
	 */
	async initialize(): Promise<boolean> {
		const progress = new SyncProgressModal(this.app);
		progress.open();
		try {
			progress.setMessage("Connecting to GitLab...");
			await this.backend.initialize(
				(phase, loaded, total) => {
					progress.setMessage(phase);
					if (total > 0) {
						progress.setDetail(
							`${loaded} / ${total}`,
						);
					}
				},
			);

			// Check if this is the first sync (no state)
			const isFirstSync =
				this.stateManager.getLastSyncTimestamp() === 0;
			progress.close();

			if (isFirstSync) {
				return this.handleFirstSync();
			}
			return true;
		} catch (err) {
			progress.close();
			throw err;
		}
	}

	/** Pull remote changes into the vault. */
	async pull(): Promise<void> {
		if (this.syncing) {
			throw new Error("A sync operation is already in progress.");
		}
		this.syncing = true;
		try {
			await this.doPull();
		} finally {
			this.syncing = false;
		}
	}

	/** Push local changes to the remote. */
	async push(): Promise<void> {
		if (this.syncing) {
			throw new Error("A sync operation is already in progress.");
		}
		this.syncing = true;
		try {
			await this.doPush();
		} finally {
			this.syncing = false;
		}
	}

	/** Push a user-selected subset of local changes with a custom commit message. */
	async pushWithSelection(): Promise<void> {
		if (this.syncing) {
			throw new Error("A sync operation is already in progress.");
		}
		this.syncing = true;
		try {
			await this.doPushWithSelection();
		} finally {
			this.syncing = false;
		}
	}

	/** Full sync: pull then push. */
	async fullSync(): Promise<void> {
		if (this.syncing) {
			throw new Error("A sync operation is already in progress.");
		}
		this.syncing = true;
		try {
			// Re-initialize to get latest remote state
			await this.backend.initialize();
			await this.doPull();
			await this.doPush();
		} finally {
			this.syncing = false;
		}
	}

	// ── Internal sync flows ─────────────────────────────────

	private async doPull(): Promise<void> {
		const remoteFiles = await this.backend.getRemoteFileList(
			this.settings.remoteSubfolder || undefined,
		);

		// Update the dot-dir map before any path translation so new hidden
		// directories discovered on remote are mapped immediately.
		await this.updateDotDirMap(remoteFiles.map((rf) => rf.path));

		const changes = await detectChanges(
			this.vault,
			this.stateManager,
			remoteFiles,
			(path) => this.backend.getRemoteFileContent(path),
			this.settings.vaultSubfolder,
			this.settings.remoteSubfolder,
			this.effectiveDotDirMap,
		);

		// 1. Apply remote-only changes (auto-update vault)
		for (const change of changes.remoteChanges) {
			if (change.type === ChangeType.DELETED) {
				continue; // Handle deletions separately below
			}

			try {
				const content = await this.backend.getRemoteFileContent(change.path);
				const vaultPath = remotePathToVaultPath(
					change.path,
					this.settings.remoteSubfolder,
					this.settings.vaultSubfolder,
					this.effectiveDotDirMap,
				);

				await this.writeVaultFile(vaultPath, content);

				// Update sync state only after a confirmed successful write
				const remoteSha =
					remoteFiles.find((rf) => rf.path === change.path)?.sha ?? "";
				await this.updateFileState(change.path, content, remoteSha);
			} catch (err) {
				console.warn(`[GitLab Connector] Skipping unwritable remote file ${change.path}:`, err);
			}
		}

		// 2. Handle remote deletions (ask user)
		const remoteDeletions = changes.remoteChanges.filter(
			(c) => c.type === ChangeType.DELETED,
		);
		if (remoteDeletions.length > 0) {
			const deletionPaths = remoteDeletions.map((c) => c.path);
			const modal = new DeletionConfirmModal(this.app, deletionPaths);
			const choices = await modal.openAndWait();
			for (const choice of choices) {
				if (choice.deleteLocally) {
					const vaultPath = remotePathToVaultPath(
						choice.path,
						this.settings.remoteSubfolder,
						this.settings.vaultSubfolder,
						this.effectiveDotDirMap,
					);
					const file = this.vault.getFileByPath(vaultPath);
					if (file) {
						await this.vault.trash(file, true);
					} else {
						try {
							await this.vault.adapter.remove(normalizePath(vaultPath));
						} catch { /* already gone */ }
					}
				}
				// Either way, remove from sync state
				this.stateManager.removeFileState(choice.path);
			}
		}

		// 3. Handle conflicts (both-changed files)
		if (changes.bothChanged.length > 0) {
			const conflicts = await classifyConflicts(
				changes.bothChanged,
				this.vault,
				this.backend,
				this.stateManager,
				this.settings.vaultSubfolder,
				this.settings.remoteSubfolder,
				this.effectiveDotDirMap,
			);

			// Auto-resolve auto-mergeable conflicts silently
			const trueConflicts = conflicts.filter(
				(c) => c.kind === ConflictKind.TRUE_CONFLICT,
			);
			const autoMerged = conflicts.filter(
				(c) => c.kind === ConflictKind.AUTO_MERGEABLE,
			);

			// Apply auto-merges
			for (const am of autoMerged) {
				if (am.mergedContent !== undefined) {
					const vaultPath = remotePathToVaultPath(
						am.path,
						this.settings.remoteSubfolder,
						this.settings.vaultSubfolder,
						this.effectiveDotDirMap,
					);
					const file = this.vault.getFileByPath(vaultPath);
					if (file) {
						await this.vault.modify(file, am.mergedContent);
					} else {
						await this.vault.adapter.write(normalizePath(vaultPath), am.mergedContent);
					}
					const remoteSha =
						remoteFiles.find((rf) => rf.path === am.path)?.sha ?? "";
					await this.updateFileState(
						am.path,
						am.mergedContent,
						remoteSha,
					);
				}
			}

			// Prompt user for true conflicts
			if (trueConflicts.length > 0) {
				const modal = new ConflictModal(this.app, trueConflicts);
				const resolutions = await modal.openAndWait();
				await this.applyResolutions(resolutions, remoteFiles);
			}
		}

		// 4. Update global sync state
		try {
			const headSha = await this.backend.getRemoteHeadSha();
			this.stateManager.setLastRemoteCommitSha(headSha);
		} catch {
			// Non-critical — we still have per-file state
		}
		this.stateManager.setLastSyncTimestamp(Date.now());
		await this.stateManager.save();
	}

	private async doPush(): Promise<void> {
		// Detect local changes
		const remoteFiles = await this.backend.getRemoteFileList(
			this.settings.remoteSubfolder || undefined,
		);
		const changes = await detectChanges(
			this.vault,
			this.stateManager,
			remoteFiles,
			(path) => this.backend.getRemoteFileContent(path),
			this.settings.vaultSubfolder,
			this.settings.remoteSubfolder,
			this.effectiveDotDirMap,
		);

		if (changes.localChanges.length === 0) {
			if (changes.bothChanged.length > 0) {
				new Notice(
					`${PLUGIN_DISPLAY_NAME}: ${changes.bothChanged.length} file(s) have remote conflicts — pull first to resolve them.`,
				);
			}
			return; // Nothing to push
		}

		// Build change list with content
		const pushChanges: FileChange[] = [];
		for (const change of changes.localChanges) {
			if (change.type === ChangeType.DELETED) {
				pushChanges.push(change);
				continue;
			}
			// Read current content from vault
			const vaultPath = remotePathToVaultPath(
				change.path,
				this.settings.remoteSubfolder,
				this.settings.vaultSubfolder,
				this.effectiveDotDirMap,
			);
			const file = this.vault.getFileByPath(vaultPath);
			let content: string;
			if (file) {
				content = await this.vault.read(file);
			} else {
				try {
					content = await this.vault.adapter.read(normalizePath(vaultPath));
				} catch {
					continue; // File genuinely missing — skip
				}
			}
			pushChanges.push({
				path: change.path,
				type: change.type,
				content,
			});
		}

		if (pushChanges.length === 0) return;

		const message = this.generateCommitMessage(pushChanges);
		const result = await this.backend.pushChanges(
			pushChanges,
			message,
			this.settings.authorName,
			this.settings.authorEmail,
		);

		if (!result.success) {
			if (result.conflict) {
				throw new Error(
					"Push rejected — remote has new changes. Pull first, then push again.",
				);
			}
			throw new Error(`Push failed: ${result.error}`);
		}

		// Re-fetch the remote file list to get current blob OIDs for each pushed file.
		// Storing the commit SHA here instead would break change detection on the next
		// sync because getRemoteFileList() returns blob OIDs, not commit SHAs.
		const updatedRemote = await this.backend.getRemoteFileList(
			this.settings.remoteSubfolder || undefined,
		);
		const updatedByPath = new Map(updatedRemote.map((rf) => [rf.path, rf]));

		for (const change of pushChanges) {
			if (change.type === ChangeType.DELETED) {
				this.stateManager.removeFileState(change.path);
			} else if (change.content) {
				const hash = await sha256(change.content);
				this.stateManager.updateFileState(change.path, {
					contentHash: hash,
					baseContent: change.content,
					remoteSha: updatedByPath.get(change.path)?.sha ?? "",
					lastSynced: Date.now(),
				});
			}
		}

		this.stateManager.setLastSyncTimestamp(Date.now());
		if (result.commitSha) {
			this.stateManager.setLastRemoteCommitSha(result.commitSha);
		}
		await this.stateManager.save();
	}

	private async doPushWithSelection(): Promise<void> {
		const remoteFiles = await this.backend.getRemoteFileList(
			this.settings.remoteSubfolder || undefined,
		);
		const changes = await detectChanges(
			this.vault,
			this.stateManager,
			remoteFiles,
			(path) => this.backend.getRemoteFileContent(path),
			this.settings.vaultSubfolder,
			this.settings.remoteSubfolder,
			this.effectiveDotDirMap,
		);

		if (changes.localChanges.length === 0) {
			new Notice(`${PLUGIN_DISPLAY_NAME}: Nothing to push — no local changes detected.`);
			return;
		}

		// Load content for each local change
		const allChanges: FileChange[] = [];
		for (const change of changes.localChanges) {
			if (change.type === ChangeType.DELETED) {
				allChanges.push(change);
				continue;
			}
			const vaultPath = remotePathToVaultPath(
				change.path,
				this.settings.remoteSubfolder,
				this.settings.vaultSubfolder,
				this.effectiveDotDirMap,
			);
			const file = this.vault.getFileByPath(vaultPath);
			let content: string;
			if (file) {
				content = await this.vault.read(file);
			} else {
				try {
					content = await this.vault.adapter.read(normalizePath(vaultPath));
				} catch {
					continue; // File genuinely missing — skip
				}
			}
			allChanges.push({ path: change.path, type: change.type, content });
		}

		if (allChanges.length === 0) return;

		// Show modal — user selects files and writes commit message
		const defaultMessage = this.generateCommitMessage(allChanges);
		const modal = new CommitModal(this.app, allChanges, defaultMessage);
		const selection = await modal.openAndWait();

		if (!selection || selection.changes.length === 0) return; // cancelled

		const result = await this.backend.pushChanges(
			selection.changes,
			selection.message,
			this.settings.authorName,
			this.settings.authorEmail,
		);

		if (!result.success) {
			if (result.conflict) {
				throw new Error(
					"Push rejected — remote has new changes. Pull first, then push again.",
				);
			}
			throw new Error(`Push failed: ${result.error}`);
		}

		// Re-fetch remote file list to get current blob OIDs (not commit SHA)
		const updatedRemote = await this.backend.getRemoteFileList(
			this.settings.remoteSubfolder || undefined,
		);
		const updatedByPath = new Map(updatedRemote.map((rf) => [rf.path, rf]));

		for (const change of selection.changes) {
			if (change.type === ChangeType.DELETED) {
				this.stateManager.removeFileState(change.path);
			} else if (change.content) {
				const hash = await sha256(change.content);
				this.stateManager.updateFileState(change.path, {
					contentHash: hash,
					baseContent: change.content,
					remoteSha: updatedByPath.get(change.path)?.sha ?? "",
					lastSynced: Date.now(),
				});
			}
		}

		this.stateManager.setLastSyncTimestamp(Date.now());
		if (result.commitSha) {
			this.stateManager.setLastRemoteCommitSha(result.commitSha);
		}
		await this.stateManager.save();
	}

	// ── First-sync handling ─────────────────────────────────

	private async handleFirstSync(): Promise<boolean> {
		const remoteFiles = await this.backend.getRemoteFileList(
			this.settings.remoteSubfolder || undefined,
		);
		const localFiles = await getAllVaultMdFilePaths(
			this.vault,
			this.settings.vaultSubfolder,
		);

		const hasRemote = remoteFiles.length > 0;
		const hasLocal = localFiles.length > 0;

		if (!hasRemote && !hasLocal) {
			// Both empty — nothing to do, but mark as initialised
			this.stateManager.setLastSyncTimestamp(Date.now());
			await this.stateManager.save();
			return true;
		}

		const modal = new InitialSyncModal(this.app, hasLocal, hasRemote);
		const direction = await modal.openAndWait();

		switch (direction) {
			case InitialSyncDirection.PULL_REMOTE:
				await this.initialPull(remoteFiles);
				return true;

			case InitialSyncDirection.PUSH_LOCAL:
				await this.initialPush(localFiles);
				return true;

			case InitialSyncDirection.CANCEL:
				return false;
		}
	}

	private async initialPull(
		remoteFiles: { path: string; sha: string }[],
	): Promise<void> {
		await this.updateDotDirMap(remoteFiles.map((rf) => rf.path));

		for (const rf of remoteFiles) {
			try {
				const content = await this.backend.getRemoteFileContent(rf.path);
				const vaultPath = remotePathToVaultPath(
					rf.path,
					this.settings.remoteSubfolder,
					this.settings.vaultSubfolder,
					this.effectiveDotDirMap,
				);

				await this.writeVaultFile(vaultPath, content);
				// Update sync state only after a confirmed successful write
				await this.updateFileState(rf.path, content, rf.sha);
			} catch (err) {
				console.warn(`[GitLab Connector] Skipping unwritable remote file ${rf.path}:`, err);
			}
		}

		try {
			const headSha = await this.backend.getRemoteHeadSha();
			this.stateManager.setLastRemoteCommitSha(headSha);
		} catch {
			// non-critical
		}
		this.stateManager.setLastSyncTimestamp(Date.now());
		await this.stateManager.save();
	}

	private async initialPush(localFiles: string[]): Promise<void> {
		const changes: FileChange[] = [];
		for (const filePath of localFiles) {
			const content = await this.vault.adapter.read(normalizePath(filePath));
			const remotePath = vaultPathToRemotePath(
				filePath,
				this.settings.vaultSubfolder,
				this.settings.remoteSubfolder,
				this.effectiveDotDirMap,
			);
			changes.push({
				path: remotePath,
				type: ChangeType.CREATED,
				content,
			});
		}

		if (changes.length === 0) return;

		const message = `Initial push: ${changes.length} file(s)`;
		const result = await this.backend.pushChanges(
			changes,
			message,
			this.settings.authorName,
			this.settings.authorEmail,
		);

		if (!result.success) {
			throw new Error(`Initial push failed: ${result.error}`);
		}

		// Re-fetch remote file list to get current blob OIDs (not commit SHA)
		const updatedRemote = await this.backend.getRemoteFileList(
			this.settings.remoteSubfolder || undefined,
		);
		const updatedByPath = new Map(updatedRemote.map((rf) => [rf.path, rf]));

		for (const change of changes) {
			if (change.content) {
				const hash = await sha256(change.content);
				this.stateManager.updateFileState(change.path, {
					contentHash: hash,
					baseContent: change.content,
					remoteSha: updatedByPath.get(change.path)?.sha ?? "",
					lastSynced: Date.now(),
				});
			}
		}

		this.stateManager.setLastSyncTimestamp(Date.now());
		if (result.commitSha) {
			this.stateManager.setLastRemoteCommitSha(result.commitSha);
		}
		await this.stateManager.save();
	}

	// ── Helpers ─────────────────────────────────────────────

	private async applyResolutions(
		resolutions: ResolvedConflict[],
		remoteFiles: { path: string; sha: string }[],
	): Promise<void> {
		for (const res of resolutions) {
			const vaultPath = remotePathToVaultPath(
				res.path,
				this.settings.remoteSubfolder,
				this.settings.vaultSubfolder,
				this.effectiveDotDirMap,
			);
			const file = this.vault.getFileByPath(vaultPath);

			if (res.content !== undefined) {
				await this.writeVaultFile(vaultPath, res.content);
			}

			// Update sync state if resolved (not for EDIT_MANUALLY — user will
			// edit and the change will be picked up on the next push)
			if (
				res.resolution !== ConflictResolution.EDIT_MANUALLY &&
				res.content
			) {
				const remoteSha =
					remoteFiles.find((rf) => rf.path === res.path)?.sha ?? "";
				await this.updateFileState(res.path, res.content, remoteSha);
			}
		}
	}

	private async updateFileState(
		remotePath: string,
		content: string,
		remoteSha: string,
	): Promise<void> {
		const hash = await sha256(content);
		this.stateManager.updateFileState(remotePath, {
			contentHash: hash,
			baseContent: content,
			remoteSha,
			lastSynced: Date.now(),
		});
	}

	/**
	 * Write a file to the vault, creating the parent folder if needed.
	 * Handles the race condition where the folder or file already exists
	 * but Obsidian's index hasn't caught up yet.
	 * After a successful write, deletes any pre-remap orphan at the old
	 * dot-prefixed path (e.g. .github/foo.md when writing _github/foo.md).
	 */
	private async writeVaultFile(vaultPath: string, content: string): Promise<void> {
		await this.ensureVaultFolder(vaultPath);
		const normalized = normalizePath(vaultPath);
		const existing = this.vault.getFileByPath(vaultPath);
		if (existing) {
			await this.vault.modify(existing, content);
			await this.deleteOrphanDotCounterpart(vaultPath);
			return;
		}
		try {
			await this.vault.create(vaultPath, content);
		} catch {
			// File may have appeared between getFileByPath and create (race condition),
			// or the path is inside a hidden directory Obsidian won't index.
			const now = this.vault.getFileByPath(vaultPath);
			if (now) {
				await this.vault.modify(now, content);
			} else {
				// Hidden directory (e.g. _github/, _agents/) — write directly via adapter
				await this.vault.adapter.write(normalized, content);
			}
		}
		await this.deleteOrphanDotCounterpart(vaultPath);
	}

	/**
	 * Scan the remote paths for dot-prefixed directory segments and add any
	 * new ones to settings.dotDirMap (e.g. ".github" → "_github").
	 * Persists settings only when new entries are discovered.
	 */
	private async updateDotDirMap(remotePaths: string[]): Promise<void> {
		if (!this.settings.remapHiddenDirs) return;
		let changed = false;
		for (const rp of remotePaths) {
			const segments = rp.split("/");
			for (let i = 0; i < segments.length - 1; i++) {
				const seg = segments[i];
				if (seg.startsWith(".") && !this.settings.dotDirMap[seg]) {
					this.settings.dotDirMap[seg] = "_" + seg.slice(1);
					changed = true;
				}
			}
		}
		if (changed) await this.saveFn();
	}

	/**
	 * After writing a remapped vault file (e.g. _github/foo.md), delete the
	 * old dot-prefixed counterpart (.github/foo.md) from disk if it still
	 * exists from before the remapping feature was enabled.
	 * Only acts when remapHiddenDirs is on and a directory segment in the
	 * path is a known mapped vault name.
	 */
	private async deleteOrphanDotCounterpart(vaultPath: string): Promise<void> {
		if (!this.settings.remapHiddenDirs) return;
		const map = this.settings.dotDirMap;
		if (Object.keys(map).length === 0) return;

		// Build reverse: "_github" → ".github"
		const reverse: Record<string, string> = {};
		for (const [remote, vault] of Object.entries(map)) reverse[vault] = remote;

		const parts = vaultPath.split("/");
		const dotParts = parts.map((p, i) =>
			i < parts.length - 1 && reverse[p] ? reverse[p] : p,
		);
		if (dotParts.join("/") === parts.join("/")) return; // nothing remapped in this path

		const dotPath = normalizePath(dotParts.join("/"));
		try {
			if (await this.vault.adapter.exists(dotPath)) {
				await this.vault.adapter.remove(dotPath);
			}
		} catch {
			// Non-critical — the orphan file simply stays on disk
		}
	}

	private async ensureVaultFolder(filePath: string): Promise<void> {
		const parts = filePath.split("/");
		if (parts.length <= 1) return; // Root file — no folder needed

		// Create each directory component individually so every level is added to
		// Obsidian's vault index before we attempt to create the next level.
		//
		// Attempting to create the full path in one shot (e.g.
		// "gitlab-notes/.gitlab/issue_templates") fails when intermediate directories
		// don't exist, because vault.createFolder() does not create missing parents.
		// Doing it level-by-level means vault.create() can succeed for the file
		// (parent is indexed) so the file appears in the Obsidian explorer immediately,
		// even for directories that start with "." such as .gitlab/ or .github/.
		let current = "";
		for (let i = 0; i < parts.length - 1; i++) {
			current = current ? `${current}/${parts[i]}` : parts[i];
			const normalized = normalizePath(current);
			if (this.vault.getFolderByPath(normalized)) continue; // Already indexed
			try {
				await this.vault.createFolder(normalized);
			} catch {
				// Folder already exists on disk but not yet indexed, or vault.createFolder
				// rejected the name. Write it via the adapter so the chain exists on disk
				// even if Obsidian's index is not updated (watcher will catch it later).
				try {
					await this.vault.adapter.mkdir(normalized);
				} catch {
					// Already exists on disk — ignore
				}
			}
		}
	}

	private generateCommitMessage(changes: FileChange[]): string {
		const created = changes.filter(
			(c) => c.type === ChangeType.CREATED,
		).length;
		const modified = changes.filter(
			(c) => c.type === ChangeType.MODIFIED,
		).length;
		const deleted = changes.filter(
			(c) => c.type === ChangeType.DELETED,
		).length;

		const parts: string[] = [];
		if (created > 0) parts.push(`${created} created`);
		if (modified > 0) parts.push(`${modified} modified`);
		if (deleted > 0) parts.push(`${deleted} deleted`);

		return `vault sync: ${parts.join(", ")}`;
	}
}
