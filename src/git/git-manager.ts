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
import { isMarkdownFile, isInSubfolder } from "../utils/path";

export interface GitManagerConfig {
	/** Full HTTPS clone URL (e.g. https://gitlab.com/user/repo.git). */
	remoteUrl: string;
	/** Branch to operate on. */
	branch: string;
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
export interface GitFileEntry {
	/** Path relative to the repo root. */
	path: string;
	/** Git object ID (SHA) of the blob. */
	oid: string;
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

	/** Fetch latest changes from remote (shallow). */
	async fetch(): Promise<void> {
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
	}

	/** Push local commits to remote. */
	async push(): Promise<void> {
		const result = await git.push({
			fs: this.fs,
			http,
			dir: this.dir,
			ref: this.config.branch,
			onAuth: this.onAuth,
			onAuthFailure: this.onAuthFailure,
		});

		if (result.error) {
			throw new Error(`Git push failed: ${result.error}`);
		}
	}

	// ── Tree walking (read .md files without full checkout) ─

	/**
	 * List all .md files in the given subfolder by walking the git tree.
	 * Does NOT write files to the LightningFS working directory.
	 */
	async listMdFiles(subfolder?: string): Promise<GitFileEntry[]> {
		const entries: GitFileEntry[] = [];

		await git.walk({
			fs: this.fs,
			dir: this.dir,
			trees: [git.TREE({ ref: this.config.branch })],
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
		const resolvedRef = ref ?? this.config.branch;

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

		return new TextDecoder().decode(blob);
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
		return new TextDecoder().decode(blob);
	}

	// ── Working directory operations (for commit/push) ──────

	/**
	 * Write a file to the LightningFS working directory.
	 * This is needed before staging and committing.
	 */
	async writeFile(filepath: string, content: string): Promise<void> {
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

	/** Create a commit with all staged changes. */
	async commit(message: string): Promise<string> {
		const sha = await git.commit({
			fs: this.fs,
			dir: this.dir,
			message,
			author: {
				name: this.config.authorName,
				email: this.config.authorEmail,
			},
		});
		return sha;
	}

	// ── Queries ─────────────────────────────────────────────

	/** Get the SHA of the HEAD commit. */
	async getHeadSha(): Promise<string> {
		return git.resolveRef({
			fs: this.fs,
			dir: this.dir,
			ref: "HEAD",
		});
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
	 * Perform a fast-forward merge of the fetched remote branch.
	 * isomorphic-git does not have a merge command, so we manually
	 * update the local branch ref to point to the remote tracking ref.
	 */
	async fastForwardToRemote(): Promise<void> {
		const remoteRef = `refs/remotes/origin/${this.config.branch}`;
		const remoteSha = await git.resolveRef({
			fs: this.fs,
			dir: this.dir,
			ref: remoteRef,
		});

		await git.writeRef({
			fs: this.fs,
			dir: this.dir,
			ref: `refs/heads/${this.config.branch}`,
			value: remoteSha,
			force: true,
		});

		// Also update HEAD if it points to this branch
		try {
			await git.checkout({
				fs: this.fs,
				dir: this.dir,
				ref: this.config.branch,
				force: true,
			});
		} catch {
			// checkout may fail if there's no working tree — that's ok
			// since we read from the tree directly
		}
	}
}
