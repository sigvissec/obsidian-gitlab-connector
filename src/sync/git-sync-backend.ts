/**
 * Sync backend implementation using isomorphic-git.
 *
 * Clones the full repository into LightningFS (IndexedDB),
 * then walks the git tree to read only .md files from the
 * configured subfolder.  Supports offline commits.
 */

import type { SyncBackend } from "./sync-backend";
import type { FileChange, RemoteFileInfo, PushResult } from "../types";
import { ChangeType } from "../types";
import { GitManager, GitManagerConfig } from "../git/git-manager";

export class GitSyncBackend implements SyncBackend {
	readonly name = "isomorphic-git";
	private git: GitManager;
	private subfolder: string;

	constructor(config: GitManagerConfig, subfolder: string) {
		this.git = new GitManager(config);
		this.subfolder = subfolder;
	}

	async initialize(
		onProgress?: (phase: string, loaded: number, total: number) => void,
	): Promise<void> {
		const cloned = await this.git.isCloned();
		if (!cloned) {
			await this.git.clone(onProgress);
			// Create or checkout the working branch after cloning the base branch
			await this.git.ensureWorkingBranch();
		} else {
			await this.git.fetch();
			await this.git.fastForwardToRemote();
			await this.git.ensureWorkingBranch();
		}
	}

	async getRemoteFileList(subfolder?: string): Promise<RemoteFileInfo[]> {
		const folder = subfolder ?? this.subfolder;
		const entries = await this.git.listMdFiles(folder);
		return entries.map((e) => ({
			path: e.path,
			sha: e.oid,
		}));
	}

	async getRemoteFileContent(path: string): Promise<string> {
		return this.git.readFileFromTree(path);
	}

	async getRemoteHeadSha(): Promise<string> {
		return this.git.getHeadSha();
	}

	async pushChanges(
		changes: FileChange[],
		commitMessage: string,
		_authorName: string,
		_authorEmail: string,
	): Promise<PushResult> {
		// Snapshot the local branch HEAD before creating a commit so we can roll
		// back if the subsequent push fails.  A failed push leaves a dangling
		// local commit that would otherwise corrupt the "remote" view returned by
		// getRemoteFileList() (which reads from the remote tracking ref, but the
		// local ref has advanced).
		let prePushSha: string | null = null;
		try {
			prePushSha = await this.git.getLocalHeadSha();
		} catch {
			// Brand-new branch with no commits yet — nothing to snapshot
		}

		try {
			// Write each changed file to the LightningFS working directory
			// and stage it for commit
			for (const change of changes) {
				if (change.type === ChangeType.DELETED) {
					await this.git.deleteFile(change.path);
					await this.git.unstageFile(change.path);
				} else {
					await this.git.writeFile(change.path, change.content ?? "");
					await this.git.stageFile(change.path);
				}
			}

			// Commit and push
			const sha = await this.git.commit(commitMessage);
			await this.git.push();

			return { success: true, commitSha: sha };
		} catch (err) {
			// Push failed — roll back the local commit so the next call to
			// getRemoteFileList() does not see the phantom committed content.
			if (prePushSha) {
				try {
					await this.git.resetBranch(prePushSha);
				} catch {
					// Best-effort; if reset also fails we at least report the push error
				}
			}

			const message = err instanceof Error ? err.message : String(err);
			const isConflict =
				message.includes("not fast-forward") ||
				message.includes("rejected");
			return {
				success: false,
				error: message,
				conflict: isConflict,
			};
		}
	}

	async dispose(): Promise<void> {
		// Nothing to clean up — LightningFS persists in IndexedDB
	}

	/** Expose the underlying git manager for advanced operations. */
	getGitManager(): GitManager {
		return this.git;
	}
}
