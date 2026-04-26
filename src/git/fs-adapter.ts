/**
 * Filesystem adapter for isomorphic-git.
 *
 * Uses LightningFS (IndexedDB-backed) on all platforms for consistency.
 * The git repo lives entirely inside IndexedDB — never on the visible
 * vault filesystem — so Obsidian's file indexer never sees .git metadata.
 */

import FS from "@isomorphic-git/lightning-fs";
import { LIGHTNING_FS_DB_NAME, GIT_REPO_DIR } from "../constants";

let fsInstance: FS | null = null;

/**
 * Get (or create) the LightningFS instance used for git operations.
 * The same instance is reused for the lifetime of the plugin.
 */
export function getFs(): FS {
	if (!fsInstance) {
		fsInstance = new FS(LIGHTNING_FS_DB_NAME);
	}
	return fsInstance;
}

/**
 * The virtual directory path where the git working tree lives
 * inside LightningFS.
 */
export function getRepoDir(): string {
	return GIT_REPO_DIR;
}

/**
 * Wipe the entire LightningFS database.
 * Used when the user wants to reset and re-clone.
 */
export function wipeFs(): void {
	fsInstance = new FS(LIGHTNING_FS_DB_NAME, { wipe: true });
}

/**
 * Check if the repo directory already exists (i.e. has been cloned).
 */
export async function repoExists(): Promise<boolean> {
	const fs = getFs();
	try {
		await fs.promises.stat(GIT_REPO_DIR);
		// Also verify .git exists inside it
		await fs.promises.stat(`${GIT_REPO_DIR}/.git`);
		return true;
	} catch {
		return false;
	}
}

/**
 * Ensure the repo directory exists (create it if missing).
 */
export async function ensureRepoDir(): Promise<void> {
	const fs = getFs();
	try {
		await fs.promises.stat(GIT_REPO_DIR);
	} catch {
		await fs.promises.mkdir(GIT_REPO_DIR);
	}
}
