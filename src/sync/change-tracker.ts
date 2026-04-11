/**
 * Detects what has changed locally in the vault and remotely
 * on GitLab since the last sync, by comparing current state
 * against the persisted SyncState.
 */

import type { Vault } from "obsidian";
import { normalizePath } from "obsidian";
import type { RemoteFileInfo, FileChange } from "../types";
import { ChangeType } from "../types";
import type { StateManager, FileSyncState } from "./state-manager";
import { sha256 } from "../utils/hash";
import { getAllVaultMdFilePaths } from "./file-filter";
import {
	vaultPathToRemotePath,
	remotePathToVaultPath,
} from "../utils/path";

export interface ChangeDetectionResult {
	localChanges: FileChange[];
	remoteChanges: FileChange[];
	/** Files changed both locally and remotely (need conflict resolution). */
	bothChanged: string[];
}

/**
 * Detect all changes since last sync.
 *
 * @param vault          Obsidian vault
 * @param stateManager   Persisted sync state
 * @param remoteFiles    Current remote file list (from backend)
 * @param remoteContents Callback to lazily fetch remote file content
 * @param vaultSubfolder Vault subfolder being synced
 * @param remoteSubfolder Remote subfolder being synced
 */
export async function detectChanges(
	vault: Vault,
	stateManager: StateManager,
	remoteFiles: RemoteFileInfo[],
	remoteContents: (path: string) => Promise<string>,
	vaultSubfolder: string,
	remoteSubfolder: string,
	dotDirMap: Record<string, string> = {},
): Promise<ChangeDetectionResult> {
	const localChanges: FileChange[] = [];
	const remoteChanges: FileChange[] = [];
	const bothChanged: string[] = [];

	// Build lookup of remote files by path
	const remoteByPath = new Map<string, RemoteFileInfo>();
	for (const rf of remoteFiles) {
		remoteByPath.set(rf.path, rf);
	}

	// Build lookup of local files by their remote-equivalent path.
	// getAllVaultMdFilePaths scans hidden directories (e.g. .github/) that
	// vault.getMarkdownFiles() skips, so agent/skill files are included.
	const localFilePaths = await getAllVaultMdFilePaths(vault, vaultSubfolder);
	const localByRemotePath = new Map<string, { vaultPath: string; content: string }>();
	for (const filePath of localFilePaths) {
		try {
			const content = await vault.adapter.read(normalizePath(filePath));
			const remotePath = vaultPathToRemotePath(
				filePath,
				vaultSubfolder,
				remoteSubfolder,
				dotDirMap,
			);
			localByRemotePath.set(remotePath, {
				vaultPath: filePath,
				content,
			});
		} catch {
			// File disappeared between listing and reading — skip it
		}
	}

	// All known paths (union of tracked, local, and remote)
	const allPaths = new Set<string>([
		...stateManager.getAllTrackedPaths(),
		...remoteByPath.keys(),
		...localByRemotePath.keys(),
	]);

	for (const remotePath of allPaths) {
		const tracked = stateManager.getFileState(remotePath);
		const remote = remoteByPath.get(remotePath);
		const local = localByRemotePath.get(remotePath);

		const localChanged = await isLocalChanged(tracked, local?.content);
		const remoteChanged = isRemoteChanged(tracked, remote);

		if (localChanged && remoteChanged) {
			// Both sides changed — potential conflict
			bothChanged.push(remotePath);
		} else if (localChanged) {
			// Only local changed
			if (local && !tracked) {
				// New local file not yet tracked
				localChanges.push({
					path: remotePath,
					type: ChangeType.CREATED,
					content: local.content,
				});
			} else if (local && tracked) {
				// Modified locally
				localChanges.push({
					path: remotePath,
					type: ChangeType.MODIFIED,
					content: local.content,
				});
			} else if (!local && tracked) {
				// Deleted locally
				localChanges.push({
					path: remotePath,
					type: ChangeType.DELETED,
				});
			}
		} else if (remoteChanged) {
			// Only remote changed
			if (remote && !tracked) {
				// New remote file
				remoteChanges.push({
					path: remotePath,
					type: ChangeType.CREATED,
				});
			} else if (remote && tracked && remote.sha !== tracked.remoteSha) {
				// Modified remotely
				remoteChanges.push({
					path: remotePath,
					type: ChangeType.MODIFIED,
				});
			} else if (!remote && tracked) {
				// Deleted remotely
				remoteChanges.push({
					path: remotePath,
					type: ChangeType.DELETED,
				});
			}
		}
		// If neither changed, nothing to do
	}

	return { localChanges, remoteChanges, bothChanged };
}

/** Check if local content differs from the last-synced state. */
async function isLocalChanged(
	tracked: FileSyncState | undefined,
	localContent: string | undefined,
): Promise<boolean> {
	if (!tracked && localContent !== undefined) {
		// New local file, never tracked
		return true;
	}
	if (tracked && localContent === undefined) {
		// Was tracked, now missing locally
		return true;
	}
	if (tracked && localContent !== undefined) {
		const hash = await sha256(localContent);
		return hash !== tracked.contentHash;
	}
	return false;
}

/** Check if remote state differs from the last-synced state. */
function isRemoteChanged(
	tracked: FileSyncState | undefined,
	remote: RemoteFileInfo | undefined,
): boolean {
	if (!tracked && remote) {
		// New remote file, never tracked
		return true;
	}
	if (tracked && !remote) {
		// Was tracked, now missing remotely
		return true;
	}
	if (tracked && remote) {
		return remote.sha !== tracked.remoteSha;
	}
	return false;
}
