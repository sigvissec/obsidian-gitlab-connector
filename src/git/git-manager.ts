/**
 * High-level wrapper around isomorphic-git operations.
 *
 * All git operations go through this class. It manages the
 * LightningFS instance, auth, and provides typed methods
 * for the operations the sync engine needs.
 */

import git from "isomorphic-git";
import type { ReadCommitResult, AuthCallback, AuthFailureCallback } from "isomorphic-git";
import { httpAdapter as http } from "./http-adapter";
import type FS from "@isomorphic-git/lightning-fs";
import { getFs, getRepoDir, repoExists, ensureRepoDir, wipeFs } from "./fs-adapter";
import { createAuthCallback, createAuthFailureCallback } from "./auth";
import { isMarkdownFile, isInSubfolder, assertSafePath } from "../utils/path";

export interface GitManagerConfig {
	/** Full HTTPS clone URL (e.g. https://gitlab.com/user/repo.git). */
	remoteUrl: string;
	/** Remote source branch to clone and fetch from (the "base" branch). */
	branch: string;
	/**
	 * Branch that local commits are pushed to.
	 * If empty or equal to `branch`, pushes go directly to `branch`.
	 * Created from `branch` automatically if it doesn't exist on the remote.
	 */
	workingBranch?: string;
	/** Personal Access Token for auth. */
	token: string;
	/** Shallow clone depth. */
	depth: number;
	/** Commit author name. */
	authorName: string;
	/** Commit author email. */
	authorEmail: string;
}

/** Entry returned by listMdFiles. */
interface GitFileEntry {
	/** Path relative to the repo root. */
	path: string;
	/** Git object ID (SHA) of the blob. */
	oid: string;
}

/**
 * Decode a blob as UTF-8, throwing on invalid sequences instead of silently
 * substituting U+FFFD. Prevents binary or non-UTF-8 files from being silently
 * corrupted when round-tripped through the sync engine.
 */
function decodeUtf8Strict(blob: Uint8Array, ident: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(blob);
	} catch {
		throw new Error(
			`File is not valid UTF-8 and cannot be synced as text: ${ident}`,
		);
	}
}

export class GitManager {
	private fs: FS;
	private dir: string;
	private config: GitManagerConfig;
	private onAuth: AuthCallback;
	private onAuthFailure: AuthFailureCallback;

	constructor(config: GitManagerConfig) {
		this.fs = getFs();
		this.dir = getRepoDir();
		this.config = config;
		this.onAuth = createAuthCallback(config.token);
		this.onAuthFailure = createAuthFailureCallback();
	}

	/** Update configuration (e.g., after settings change). */
	updateConfig(config: Partial<GitManagerConfig>): void {
		Object.assign(this.config, config);
		if (config.token) {
			this.onAuth = createAuthCallback(config.token);
		}
	}

	/**
	 * The branch used for commits and pushes.
	 * Equals `workingBranch` if set and different from `branch`, otherwise `branch`.
	 */
	get effectiveBranch(): string {
		const wb = this.config.workingBranch;
		return wb && wb !== this.config.branch ? wb : this.config.branch;
	}

	// ── Repository lifecycle ────────────────────────────────

	/** Check if the local repo has already been cloned. */
	async isCloned(): Promise<boolean> {
		return repoExists();
	}

	/**
	 * Clone the remote repository (shallow).
	 * Overwrites any existing repo in LightningFS.
	 */
	async clone(
		onProgress?: (phase: string, loaded: number, total: number) => void,
	): Promise<void> {
		await wipeFs();
		// Re-acquire fs after wipe
		this.fs = getFs();
		await ensureRepoDir();

		await git.clone({
			fs: this.fs,
			http,
			dir: this.dir,
			url: this.config.remoteUrl,
			ref: this.config.branch,
			singleBranch: true,
			depth: this.config.depth,
			onAuth: this.onAuth,
			onAuthFailure: this.onAuthFailure,
			onProgress: onProgress
				? (event) =>
						onProgress(
							event.phase,
							event.loaded,
							event.total ?? 0,
						)
				: undefined,
		});
	}

	/** Fetch latest changes from remote (shallow). Tries the working branch first. */
	async fetch(): Promise<void> {
		const wb = this.effectiveBranch;
		try {
			await git.fetch({
				fs: this.fs,
				http,
				dir: this.dir,
				ref: wb,
				singleBranch: true,
				depth: this.config.depth,
				onAuth: this.onAuth,
				onAuthFailure: this.onAuthFailure,
			});
		} catch (err) {
			// Working branch may not exist on remote yet — fall back to base branch
			if (wb !== this.config.branch) {
				await git.fetch({
					fs: this.fs,
					http,
					dir: this.dir,
					ref: this.config.branch,
					singleBranch: true,
					depth: this.config.depth,
					onAuth: this.onAuth,
					onAuthFailure: this.onAuthFailure,
				});
			} else {
				throw err;
			}
		}
	}

	/**
	 * Ensure the working branch exists locally and is in sync with the remote.
	 *
	 * If the remote has the working branch, fast-forward the local copy to match.
	 * If not, create a local branch from current HEAD.
	 *
	 * When a single-branch clone was used (singleBranch:true for the source
	 * branch), the working branch's remote tracking ref may not exist locally
	 * even if it exists on the server.  We therefore try a fetch before
	 * concluding the branch doesn't exist on remote.
	 */
	async ensureWorkingBranch(): Promise<void> {
		const wb = this.effectiveBranch;
		if (wb === this.config.branch) return; // Same branch — nothing to do

		const remoteRef = `refs/remotes/origin/${wb}`;
		let remoteExists = false;

		// First check if the remote tracking ref is already populated locally
		try {
			await git.resolveRef({ fs: this.fs, dir: this.dir, ref: remoteRef });
			remoteExists = true;
		} catch {
			// Not in local refs — the clone may have been singleBranch for the
			// source branch only.  Try fetching the working branch from remote.
			try {
				await git.fetch({
					fs: this.fs,
					http,
					dir: this.dir,
					ref: wb,
					singleBranch: true,
					depth: this.config.depth,
					onAuth: this.onAuth,
					onAuthFailure: this.onAuthFailure,
				});
				// If fetch succeeded the remote tracking ref is now populated
				await git.resolveRef({ fs: this.fs, dir: this.dir, ref: remoteRef });
				remoteExists = true;
			} catch {
				// Branch truly doesn't exist on remote — will be created on first push
			}
		}

		const sha = remoteExists
			? await git.resolveRef({ fs: this.fs, dir: this.dir, ref: remoteRef })
			: await git.resolveRef({ fs: this.fs, dir: this.dir, ref: "HEAD" });

		await git.writeRef({
			fs: this.fs,
			dir: this.dir,
			ref: `refs/heads/${wb}`,
			value: sha,
			force: true,
		});

		// Checkout the working branch
		try {
			await git.checkout({ fs: this.fs, dir: this.dir, ref: wb, force: true });
		} catch {
			// Checkout may fail on a bare-ish tree — that's OK; we read via tree walk
		}
	}

	/** Push local commits to the working branch on remote. */
	async push(): Promise<void> {
		const wb = this.effectiveBranch;
		const result = await git.push({
			fs: this.fs,
			http,
			dir: this.dir,
			ref: wb,
			remoteRef: wb,
			onAuth: this.onAuth,
			onAuthFailure: this.onAuthFailure,
		});

		if (result.error) {
			throw new Error(`Git push failed: ${result.error}`);
		}
	}

	// ── Tree walking (read .md files without full checkout) ─

	/**
	 * Returns the best ref to use when reading "remote" state.
	 *
	 * Prefers `refs/remotes/origin/<effectiveBranch>` so that a locally-committed
	 * but not-yet-pushed commit (or a failed push) does not pollute the "remote"
	 * view returned by listMdFiles / readFileFromTree.
	 *
	 * Falls back to the local branch ref only when no remote tracking ref exists
	 * yet (i.e., the working branch has never been pushed).
	 */
	private async remoteTreeRef(): Promise<string> {
		const remoteRef = `refs/remotes/origin/${this.effectiveBranch}`;
		try {
			await git.resolveRef({ fs: this.fs, dir: this.dir, ref: remoteRef });
			return remoteRef;
		} catch {
			// No remote tracking ref — branch has never been pushed; use local ref
			return this.effectiveBranch;
		}
	}

	/**
	 * List all .md files in the given subfolder by walking the git tree.
	 * Does NOT write files to the LightningFS working directory.
	 */
	async listMdFiles(subfolder?: string): Promise<GitFileEntry[]> {
		const entries: GitFileEntry[] = [];
		const treeRef = await this.remoteTreeRef();

		await git.walk({
			fs: this.fs,
			dir: this.dir,
			trees: [git.TREE({ ref: treeRef })],
			map: async (filepath, [entry]) => {
				if (!entry) return undefined;
				// Skip the root "." entry
				if (filepath === ".") return undefined;

				const type = await entry.type();
				if (type !== "blob") return undefined;

				if (!isMarkdownFile(filepath)) return undefined;
				if (subfolder && !isInSubfolder(filepath, subfolder))
					return undefined;

				const oid = await entry.oid();
				entries.push({ path: filepath, oid });
				return undefined;
			},
		});

		return entries;
	}

	/**
	 * Read the content of a single file from the git tree (by OID or path).
	 * Does NOT use the working directory.
	 */
	async readFileFromTree(filepath: string, ref?: string): Promise<string> {
		const resolvedRef = ref ?? await this.remoteTreeRef();

		const { blob } = await git.readBlob({
			fs: this.fs,
			dir: this.dir,
			oid: await git.resolveRef({
				fs: this.fs,
				dir: this.dir,
				ref: resolvedRef,
			}),
			filepath,
		});

		return decodeUtf8Strict(blob, filepath);
	}

	/**
	 * Read file content by its blob OID directly.
	 */
	async readBlob(oid: string): Promise<string> {
		const { blob } = await git.readBlob({
			fs: this.fs,
			dir: this.dir,
			oid,
		});
		return decodeUtf8Strict(blob, oid);
	}

	// ── Working directory operations (for commit/push) ──────

	/**
	 * Write a file to the LightningFS working directory.
	 * This is needed before staging and committing.
	 */
	async writeFile(filepath: string, content: string): Promise<void> {
		assertSafePath(filepath);
		const fullPath = `${this.dir}/${filepath}`;
		// Ensure parent directories exist
		const parts = filepath.split("/");
		let current = this.dir;
		for (let i = 0; i < parts.length - 1; i++) {
			current += `/${parts[i]}`;
			try {
				await this.fs.promises.stat(current);
			} catch {
				await this.fs.promises.mkdir(current);
			}
		}
		await this.fs.promises.writeFile(fullPath, content, "utf8");
	}

	/** Delete a file from the LightningFS working directory. */
	async deleteFile(filepath: string): Promise<void> {
		assertSafePath(filepath);
		const fullPath = `${this.dir}/${filepath}`;
		try {
			await this.fs.promises.unlink(fullPath);
		} catch {
			// File may not exist in working dir — that's fine
		}
	}

	/** Stage a file for the next commit. */
	async stageFile(filepath: string): Promise<void> {
		await git.add({
			fs: this.fs,
			dir: this.dir,
			filepath,
		});
	}

	/** Remove a file from the git index (stage deletion). */
	async unstageFile(filepath: string): Promise<void> {
		await git.remove({
			fs: this.fs,
			dir: this.dir,
			filepath,
		});
	}

	/** Create a commit with all staged changes on the working branch. */
	async commit(message: string): Promise<string> {
		const sha = await git.commit({
			fs: this.fs,
			dir: this.dir,
			ref: this.effectiveBranch,
			message,
			author: {
				name: this.config.authorName,
				email: this.config.authorEmail,
			},
		});
		return sha;
	}

	// ── Queries ─────────────────────────────────────────────

	/** Get the name of the currently checked-out branch, or null if detached HEAD. */
	async getCurrentBranch(): Promise<string | null> {
		return (await git.currentBranch({ fs: this.fs, dir: this.dir })) ?? null;
	}

	/**
	 * Get the SHA of the HEAD commit as seen on the remote tracking branch.
	 * Falls back to the local branch if no remote tracking ref exists yet.
	 */
	async getHeadSha(): Promise<string> {
		const ref = await this.remoteTreeRef();
		return git.resolveRef({ fs: this.fs, dir: this.dir, ref });
	}

	/**
	 * Get the SHA of the most recent local commit on the working branch,
	 * regardless of whether it has been pushed.
	 * Used to snapshot state before committing so a failed push can be rolled back.
	 */
	async getLocalHeadSha(): Promise<string> {
		return git.resolveRef({
			fs: this.fs,
			dir: this.dir,
			ref: `refs/heads/${this.effectiveBranch}`,
		});
	}

	/**
	 * Reset the local working branch to the given commit SHA and force-checkout
	 * the working tree to match.
	 *
	 * Called after a push failure to undo the local commit so that subsequent
	 * calls to listMdFiles() / getRemoteFileList() do not see phantom content.
	 */
	async resetBranch(sha: string): Promise<void> {
		await git.writeRef({
			fs: this.fs,
			dir: this.dir,
			ref: `refs/heads/${this.effectiveBranch}`,
			value: sha,
			force: true,
		});
		try {
			await git.checkout({
				fs: this.fs,
				dir: this.dir,
				ref: this.effectiveBranch,
				force: true,
			});
		} catch {
			// Working tree may not be fully materialised in headless use — ignore
		}
	}

	/** Get recent commit log entries. */
	async log(depth = 10): Promise<ReadCommitResult[]> {
		return git.log({
			fs: this.fs,
			dir: this.dir,
			depth,
		});
	}

	/** Get the status of a single file relative to HEAD. */
	async fileStatus(
		filepath: string,
	): Promise<string> {
		return git.status({
			fs: this.fs,
			dir: this.dir,
			filepath,
		});
	}

	/**
	 * Perform a fast-forward of the effective branch to its remote tracking ref.
	 * Falls back to the base branch if the working branch doesn't have a remote yet.
	 */
	async fastForwardToRemote(): Promise<void> {
		const wb = this.effectiveBranch;
		const remoteRef = `refs/remotes/origin/${wb}`;

		let remoteSha: string;
		try {
			remoteSha = await git.resolveRef({
				fs: this.fs,
				dir: this.dir,
				ref: remoteRef,
			});
		} catch {
			// Working branch not on remote — fall back to base branch ref
			const baseRef = `refs/remotes/origin/${this.config.branch}`;
			remoteSha = await git.resolveRef({
				fs: this.fs,
				dir: this.dir,
				ref: baseRef,
			});
		}

		await git.writeRef({
			fs: this.fs,
			dir: this.dir,
			ref: `refs/heads/${wb}`,
			value: remoteSha,
			force: true,
		});

		try {
			await git.checkout({ fs: this.fs, dir: this.dir, ref: wb, force: true });
		} catch {
			// checkout may fail if there's no working tree — that's ok
		}
	}
}
