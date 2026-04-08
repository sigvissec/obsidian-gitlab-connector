/**
 * Conflict classification.
 *
 * Given files that changed on both sides, determines whether they
 * can be auto-merged or require user intervention.
 */

import type { Vault } from "obsidian";
import type { ConflictInfo } from "../types";
import { ConflictKind } from "../types";
import type { StateManager } from "./state-manager";
import type { SyncBackend } from "./sync-backend";
import { tryThreeWayMerge } from "../utils/diff";
import { vaultPathToRemotePath, remotePathToVaultPath } from "../utils/path";

/**
 * For each path that changed on both sides, fetch the three versions
 * (base, local, remote) and classify the conflict.
 *
 * @param paths           Remote paths of files that changed on both sides
 * @param vault           Obsidian vault (for reading local content)
 * @param backend         Sync backend (for reading remote content)
 * @param stateManager    Persisted sync state (for reading base content)
 * @param vaultSubfolder  Vault subfolder
 * @param remoteSubfolder Remote subfolder
 */
export async function classifyConflicts(
	paths: string[],
	vault: Vault,
	backend: SyncBackend,
	stateManager: StateManager,
	vaultSubfolder: string,
	remoteSubfolder: string,
): Promise<ConflictInfo[]> {
	const conflicts: ConflictInfo[] = [];

	for (const remotePath of paths) {
		const vaultPath = remotePathToVaultPath(
			remotePath,
			remoteSubfolder,
			vaultSubfolder,
		);

		// Base content: stored in sync state from last sync
		const tracked = stateManager.getFileState(remotePath);
		const baseContent = tracked?.baseContent ?? "";

		// Local content: current vault file
		let localContent = "";
		const localFile = vault.getFileByPath(vaultPath);
		if (localFile) {
			localContent = await vault.read(localFile);
		}

		// Remote content: from the sync backend
		let remoteContent = "";
		try {
			remoteContent = await backend.getRemoteFileContent(remotePath);
		} catch {
			// If we can't read the remote, treat as deletion
			remoteContent = "";
		}

		// Attempt three-way merge
		const mergeResult = tryThreeWayMerge(
			baseContent,
			localContent,
			remoteContent,
		);

		if (mergeResult.success) {
			conflicts.push({
				path: remotePath,
				baseContent,
				localContent,
				remoteContent,
				kind: ConflictKind.AUTO_MERGEABLE,
				mergedContent: mergeResult.merged,
			});
		} else {
			conflicts.push({
				path: remotePath,
				baseContent,
				localContent,
				remoteContent,
				kind: ConflictKind.TRUE_CONFLICT,
			});
		}
	}

	return conflicts;
}
