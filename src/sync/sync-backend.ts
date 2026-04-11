/**
 * Interface that both sync backends (isomorphic-git and REST API)
 * must implement.
 *
 * The sync engine operates against this interface so it is agnostic
 * about which backend is active.
 */

import type { FileChange, RemoteFileInfo, PushResult } from "../types";

export interface SyncBackend {
	/** Human-readable name for logging / notices. */
	readonly name: string;

	/**
	 * Initialise the backend.
	 * For isomorphic-git: clone if needed, or fetch latest.
	 * For REST API: validate token and cache the remote tree.
	 */
	initialize(
		onProgress?: (phase: string, loaded: number, total: number) => void,
	): Promise<void>;

	/**
	 * List all .md files currently on the remote (scoped to subfolder).
	 * Returns path + SHA/OID for change detection.
	 */
	getRemoteFileList(subfolder?: string): Promise<RemoteFileInfo[]>;

	/** Read the content of a single remote file. */
	getRemoteFileContent(path: string): Promise<string>;

	/** Get the SHA of the latest remote commit on the branch. */
	getRemoteHeadSha(): Promise<string>;

	/**
	 * Push a batch of changes to the remote.
	 * The backend is responsible for creating the commit.
	 */
	pushChanges(
		changes: FileChange[],
		commitMessage: string,
		authorName: string,
		authorEmail: string,
	): Promise<PushResult>;

	/** Clean up resources. */
	dispose(): Promise<void>;
}
