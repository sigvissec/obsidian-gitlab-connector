/**
 * Shared TypeScript interfaces and types for the GitLab Connector plugin.
 */

/** Which git backend the user has selected. */
export enum SyncMode {
	ISOMORPHIC_GIT = "isomorphic-git",
	REST_API = "rest-api",
}

/** How sync is triggered. */
export enum SyncTrigger {
	MANUAL = "manual",
	FILE_CHANGE = "file-change",
	AUTO_TIMER = "auto-timer",
}

/** Direction of a sync operation. */
export enum SyncDirection {
	PULL = "pull",
	PUSH = "push",
	FULL = "full",
}

/** Type of change detected for a file. */
export enum ChangeType {
	CREATED = "created",
	MODIFIED = "modified",
	DELETED = "deleted",
}

/** A single file change (local or remote). */
export interface FileChange {
	/** Path relative to the sync subfolder. */
	path: string;
	type: ChangeType;
	/** File content (absent for deletions). */
	content?: string;
}

/** Classification of a conflict. */
export enum ConflictKind {
	/** Changes don't overlap — can be auto-merged. */
	AUTO_MERGEABLE = "auto-mergeable",
	/** Overlapping changes — requires user decision. */
	TRUE_CONFLICT = "conflict",
}

/** Full context for a single file conflict. */
export interface ConflictInfo {
	/** Path relative to the sync subfolder. */
	path: string;
	/** Content at last successful sync (the merge base). */
	baseContent: string;
	/** Current local content in the vault. */
	localContent: string;
	/** Current remote content from GitLab. */
	remoteContent: string;
	/** Whether the conflict can be automatically resolved. */
	kind: ConflictKind;
	/** The auto-merged result, if kind === AUTO_MERGEABLE. */
	mergedContent?: string;
}

/** User's chosen resolution for a conflict. */
export enum ConflictResolution {
	KEEP_LOCAL = "keep-local",
	KEEP_REMOTE = "keep-remote",
	USE_MERGED = "use-merged",
	EDIT_MANUALLY = "edit-manually",
}

/** The result after the user resolves a conflict. */
export interface ResolvedConflict {
	path: string;
	resolution: ConflictResolution;
	/** Final content to write (provided for all resolutions except EDIT_MANUALLY). */
	content?: string;
}

/** Information about a remote file returned by a sync backend. */
export interface RemoteFileInfo {
	/** Path relative to the repo root (includes subfolder prefix). */
	path: string;
	/** Content SHA or blob ID for change detection. */
	sha: string;
}

/** Result of a push operation. */
export interface PushResult {
	success: boolean;
	commitSha?: string;
	error?: string;
	/** True if the push failed due to a remote conflict. */
	conflict?: boolean;
}

/** The user's staged file selection and commit message from CommitModal. */
export interface CommitSelection {
	/** The subset of file changes the user chose to include. */
	changes: FileChange[];
	/** The commit message entered by the user. */
	message: string;
}

/** Result of a three-way merge attempt. */
export interface MergeResult {
	/** Whether the merge succeeded without conflict. */
	success: boolean;
	/** The merged content if successful. */
	merged?: string;
}

/** Direction choice for first-run sync modal. */
export enum InitialSyncDirection {
	PULL_REMOTE = "pull-remote",
	PUSH_LOCAL = "push-local",
	CANCEL = "cancel",
}
