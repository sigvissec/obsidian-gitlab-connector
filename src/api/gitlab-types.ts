/**
 * Type definitions for GitLab REST API v4 responses used by this plugin.
 */

/** Item in a repository tree listing. */
export interface GitLabTreeItem {
	id: string;
	name: string;
	type: "tree" | "blob";
	path: string;
	mode: string;
}

/** File metadata returned by GET /repository/files/:path. */
export interface GitLabFileMeta {
	file_name: string;
	file_path: string;
	size: number;
	encoding: string;
	content_sha256: string;
	ref: string;
	blob_id: string;
	commit_id: string;
	last_commit_id: string;
	/** Base64-encoded content (only present on GET, not HEAD). */
	content?: string;
}

/** Commit object returned by the Commits API. */
export interface GitLabCommit {
	id: string;
	short_id: string;
	title: string;
	message: string;
	author_name: string;
	author_email: string;
	authored_date: string;
	committed_date: string;
	web_url: string;
	parent_ids: string[];
	stats?: {
		additions: number;
		deletions: number;
		total: number;
	};
}

/** Authenticated user info from GET /user. */
export interface GitLabUser {
	id: number;
	username: string;
	name: string;
	email: string;
	avatar_url: string;
	web_url: string;
}

/** Minimal project info. */
export interface GitLabProject {
	id: number;
	name: string;
	name_with_namespace: string;
	path_with_namespace: string;
	web_url: string;
	default_branch: string;
}

/** Branch info. */
export interface GitLabBranch {
	name: string;
	commit: {
		id: string;
		short_id: string;
		title: string;
	};
	default: boolean;
	protected: boolean;
}

/** A single file action for the Commits API. */
export interface GitLabCommitAction {
	action: "create" | "update" | "delete" | "move";
	file_path: string;
	content?: string;
	encoding?: "text" | "base64";
	last_commit_id?: string;
	previous_path?: string;
}

/** Request body for POST /repository/commits. */
export interface GitLabCreateCommitRequest {
	branch: string;
	commit_message: string;
	actions: GitLabCommitAction[];
	author_name?: string;
	author_email?: string;
}

/** Error response from GitLab API. */
export interface GitLabErrorResponse {
	message?: string | Record<string, string[]>;
	error?: string;
}
