/**
 * Sync backend implementation using the GitLab REST API exclusively.
 *
 * No local git repository — all operations are HTTP calls to GitLab.
 * Lighter weight than isomorphic-git but requires network connectivity
 * for every operation.
 */

import type { SyncBackend } from "./sync-backend";
import type { FileChange, RemoteFileInfo, PushResult } from "../types";
import { ChangeType } from "../types";
import { GitLabClient, GitLabApiError } from "../api/gitlab-client";
import type { GitLabCommitAction } from "../api/gitlab-types";

export class ApiSyncBackend implements SyncBackend {
	readonly name = "REST API";
	private client: GitLabClient;
	private branch: string;
	private subfolder: string;

	constructor(
		gitlabUrl: string,
		token: string,
		projectPath: string,
		branch: string,
		subfolder: string,
	) {
		this.client = new GitLabClient(gitlabUrl, token, projectPath);
		this.branch = branch;
		this.subfolder = subfolder;
	}

	async initialize(): Promise<void> {
		// Validate that the token works
		await this.client.validateToken();
	}

	async getRemoteFileList(subfolder?: string): Promise<RemoteFileInfo[]> {
		const folder = subfolder ?? this.subfolder;
		const items = await this.client.listMarkdownFiles(
			this.branch,
			folder || undefined,
		);
		return items.map((item) => ({
			path: item.path,
			sha: item.id,
		}));
	}

	async getRemoteFileContent(path: string): Promise<string> {
		return this.client.getFileContent(path, this.branch);
	}

	async getRemoteHeadSha(): Promise<string> {
		const commit = await this.client.getLatestCommit(this.branch);
		return commit.id;
	}

	async pushChanges(
		changes: FileChange[],
		commitMessage: string,
		authorName: string,
		authorEmail: string,
	): Promise<PushResult> {
		try {
			const actions: GitLabCommitAction[] = changes.map((change) => {
				switch (change.type) {
					case ChangeType.CREATED:
						return {
							action: "create" as const,
							file_path: change.path,
							content: change.content ?? "",
						};
					case ChangeType.MODIFIED:
						return {
							action: "update" as const,
							file_path: change.path,
							content: change.content ?? "",
						};
					case ChangeType.DELETED:
						return {
							action: "delete" as const,
							file_path: change.path,
						};
				}
			});

			const commit = await this.client.createCommit({
				branch: this.branch,
				commit_message: commitMessage,
				actions,
				author_name: authorName || undefined,
				author_email: authorEmail || undefined,
			});

			return { success: true, commitSha: commit.id };
		} catch (err) {
			if (err instanceof GitLabApiError) {
				return {
					success: false,
					error: err.message,
					conflict: err.isConflict,
				};
			}
			const message = err instanceof Error ? err.message : String(err);
			return { success: false, error: message };
		}
	}

	async dispose(): Promise<void> {
		// No resources to clean up
	}

	/** Expose the underlying GitLab client for settings validation etc. */
	getClient(): GitLabClient {
		return this.client;
	}
}
