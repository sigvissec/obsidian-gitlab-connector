/**
 * Sync Engine — the core orchestrator.
 *
 * Coordinates the sync backend, state manager, change tracker,
 * conflict detector, and UI modals into a coherent pull/push/full-sync flow.
 */

import type { App, Vault, TFile } from "obsidian";
import { normalizePath } from "obsidian";
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
import { getVaultMdFiles } from "./file-filter";
import type {
	FileChange,
	ConflictInfo,
	ResolvedConflict,
	PushResult,
} from "../types";
import {
	ChangeType,
	ConflictKind,
	ConflictResolution,
	InitialSyncDirection,
	SyncDirection,
} from "../types";
import { ConflictModal } from "../ui/conflict-modal";
import { DeletionConfirmModal, DeletionChoice } from "../ui/deletion-confirm-modal";
import { InitialSyncModal } from "../ui/initial-sync-modal";
import { SyncProgressModal } from "../ui/sync-progress-modal";
import type { GitLabConnectorSettings } from "../settings/settings";

export class SyncEngine {
	private app: App;
	private vault: Vault;
	private backend: SyncBackend;
	private stateManager: StateManager;
	private settings: GitLabConnectorSettings;
	private syncing = false;

	constructor(
		app: App,
		backend: SyncBackend,
		stateManager: StateManager,
		settings: GitLabConnectorSettings,
	) {
		this.app = app;
		this.vault = app.vault;
		this.backend = backend;
		this.stateManager = stateManager;
		this.settings = settings;
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

		const changes = await detectChanges(
			this.vault,
			this.stateManager,
			remoteFiles,
			(path) => this.backend.getRemoteFileContent(path),
			this.settings.vaultSubfolder,
			this.settings.remoteSubfolder,
		);

		// 1. Apply remote-only changes (auto-update vault)
		for (const change of changes.remoteChanges) {
			if (change.type === ChangeType.DELETED) {
				continue; // Handle deletions separately below
			}

			const content = await this.backend.getRemoteFileContent(change.path);
			const vaultPath = remotePathToVaultPath(
				change.path,
				this.settings.remoteSubfolder,
				this.settings.vaultSubfolder,
			);

			await this.ensureVaultFolder(vaultPath);

			if (change.type === ChangeType.CREATED) {
				const existing = this.vault.getFileByPath(vaultPath);
				if (existing) {
					await this.vault.modify(existing, content);
				} else {
					await this.vault.create(vaultPath, content);
				}
			} else {
				const file = this.vault.getFileByPath(vaultPath);
				if (file) {
					await this.vault.modify(file, content);
				} else {
					await this.vault.create(vaultPath, content);
				}
			}

			// Update sync state for this file
			const remoteSha =
				remoteFiles.find((rf) => rf.path === change.path)?.sha ?? "";
			await this.updateFileState(change.path, content, remoteSha);
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
					);
					const file = this.vault.getFileByPath(vaultPath);
					if (file) {
						await this.vault.trash(file, true);
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
					);
					const file = this.vault.getFileByPath(vaultPath);
					if (file) {
						await this.vault.modify(file, am.mergedContent);
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
		);

		if (changes.localChanges.length === 0) {
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
			);
			const file = this.vault.getFileByPath(vaultPath);
			if (file) {
				const content = await this.vault.read(file);
				pushChanges.push({
					path: change.path,
					type: change.type,
					content,
				});
			}
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

		// Update sync state for pushed files
		for (const change of pushChanges) {
			if (change.type === ChangeType.DELETED) {
				this.stateManager.removeFileState(change.path);
			} else if (change.content) {
				const hash = await sha256(change.content);
				this.stateManager.updateFileState(change.path, {
					contentHash: hash,
					baseContent: change.content,
					remoteSha: result.commitSha ?? "",
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
		const localFiles = getVaultMdFiles(
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
		for (const rf of remoteFiles) {
			const content = await this.backend.getRemoteFileContent(rf.path);
			const vaultPath = remotePathToVaultPath(
				rf.path,
				this.settings.remoteSubfolder,
				this.settings.vaultSubfolder,
			);

			await this.ensureVaultFolder(vaultPath);
			const existing = this.vault.getFileByPath(vaultPath);
			if (existing) {
				await this.vault.modify(existing, content);
			} else {
				await this.vault.create(vaultPath, content);
			}

			await this.updateFileState(rf.path, content, rf.sha);
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

	private async initialPush(localFiles: TFile[]): Promise<void> {
		const changes: FileChange[] = [];
		for (const file of localFiles) {
			const content = await this.vault.read(file);
			const remotePath = vaultPathToRemotePath(
				file.path,
				this.settings.vaultSubfolder,
				this.settings.remoteSubfolder,
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

		// Update sync state
		for (const change of changes) {
			if (change.content) {
				const hash = await sha256(change.content);
				this.stateManager.updateFileState(change.path, {
					contentHash: hash,
					baseContent: change.content,
					remoteSha: result.commitSha ?? "",
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
			);
			const file = this.vault.getFileByPath(vaultPath);

			if (res.content !== undefined && file) {
				await this.vault.modify(file, res.content);
			} else if (res.content !== undefined) {
				await this.ensureVaultFolder(vaultPath);
				await this.vault.create(vaultPath, res.content);
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

	private async ensureVaultFolder(filePath: string): Promise<void> {
		const parts = filePath.split("/");
		if (parts.length <= 1) return; // No folder needed

		const folderPath = parts.slice(0, -1).join("/");
		const normalized = normalizePath(folderPath);
		const existing = this.vault.getFolderByPath(normalized);
		if (!existing) {
			await this.vault.createFolder(normalized);
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
