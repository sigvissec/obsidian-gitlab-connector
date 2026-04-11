/**
 * GitLab REST API v4 client.
 *
 * Uses Obsidian's `requestUrl()` for all HTTP calls so that CORS
 * is handled correctly on both desktop and mobile.
 */

import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import { GITLAB_API_V4, GITLAB_MAX_PER_PAGE, MARKDOWN_EXTENSION } from "../constants";
import { encodeGitLabPath, isMarkdownFile, isInSubfolder } from "../utils/path";
import type {
	GitLabTreeItem,
	GitLabFileMeta,
	GitLabCommit,
	GitLabUser,
	GitLabProject,
	GitLabBranch,
	GitLabCreateCommitRequest,
	GitLabErrorResponse,
} from "./gitlab-types";

export class GitLabClient {
	private baseUrl: string;
	private token: string;
	private projectId: string;

	constructor(gitlabUrl: string, token: string, projectPath: string) {
		// Strip trailing slash from URL
		this.baseUrl = gitlabUrl.replace(/\/+$/, "");
		this.token = token;
		// Project path needs URL encoding for use in API paths
		this.projectId = encodeURIComponent(projectPath);
	}

	// ── Authentication ──────────────────────────────────────

	/** Validate the token by fetching the authenticated user. Requires read_user or api scope. */
	async validateToken(): Promise<GitLabUser> {
		return this.get<GitLabUser>(`${GITLAB_API_V4}/user`);
	}

	/**
	 * Validate token and project access by fetching repository branches.
	 * Requires only read_repository scope, making it compatible with the
	 * minimum scopes needed for sync operations.
	 */
	async validateAccess(): Promise<void> {
		if (!this.projectId) {
			throw new Error("Project path is required to validate access.");
		}
		await this.get<unknown[]>(
			`${GITLAB_API_V4}/projects/${this.projectId}/repository/branches`,
			{ per_page: "1" },
		);
	}

	// ── Projects ────────────────────────────────────────────

	/** List projects the authenticated user is a member of. */
	async listProjects(
		search?: string,
		perPage = 20,
	): Promise<GitLabProject[]> {
		const params: Record<string, string> = {
			membership: "true",
			per_page: String(perPage),
			order_by: "last_activity_at",
		};
		if (search) params.search = search;
		return this.get<GitLabProject[]>(
			`${GITLAB_API_V4}/projects`,
			params,
		);
	}

	// ── Branches ────────────────────────────────────────────

	/** List branches for the configured project. */
	async listBranches(): Promise<GitLabBranch[]> {
		return this.get<GitLabBranch[]>(
			`${GITLAB_API_V4}/projects/${this.projectId}/repository/branches`,
			{ per_page: String(GITLAB_MAX_PER_PAGE) },
		);
	}

	/** Check whether a branch exists. Returns false instead of throwing on 404. */
	async branchExists(branch: string): Promise<boolean> {
		try {
			await this.get<GitLabBranch>(
				`${GITLAB_API_V4}/projects/${this.projectId}/repository/branches/${encodeURIComponent(branch)}`,
			);
			return true;
		} catch (err) {
			if (err instanceof GitLabApiError && err.statusCode === 404) return false;
			throw err;
		}
	}

	/**
	 * Create a new branch from the given ref.
	 * No-ops (returns silently) if the branch already exists.
	 */
	async createBranch(branch: string, ref: string): Promise<void> {
		try {
			await this.post<GitLabBranch>(
				`${GITLAB_API_V4}/projects/${this.projectId}/repository/branches`,
				{ branch, ref },
			);
		} catch (err) {
			// GitLab returns 400 if the branch already exists
			if (err instanceof GitLabApiError && err.statusCode === 400) return;
			throw err;
		}
	}

	// ── Repository tree ─────────────────────────────────────

	/**
	 * List all markdown files in the repository, optionally scoped to a subfolder.
	 * Handles pagination automatically.
	 */
	async listMarkdownFiles(
		ref?: string,
		subfolder?: string,
	): Promise<GitLabTreeItem[]> {
		const allItems: GitLabTreeItem[] = [];
		let page = 1;
		let hasMore = true;

		while (hasMore) {
			const params: Record<string, string> = {
				recursive: "true",
				per_page: String(GITLAB_MAX_PER_PAGE),
				page: String(page),
			};
			if (ref) params.ref = ref;
			if (subfolder) params.path = subfolder;

			const items = await this.get<GitLabTreeItem[]>(
				`${GITLAB_API_V4}/projects/${this.projectId}/repository/tree`,
				params,
			);

			const mdFiles = items.filter(
				(item) =>
					item.type === "blob" && isMarkdownFile(item.path),
			);
			allItems.push(...mdFiles);

			// If we got a full page, there might be more
			hasMore = items.length === GITLAB_MAX_PER_PAGE;
			page++;
		}

		return allItems;
	}

	// ── File content ────────────────────────────────────────

	/** Get the raw content of a file. */
	async getFileContent(path: string, ref?: string): Promise<string> {
		const params: Record<string, string> = {};
		if (ref) params.ref = ref;

		const encodedPath = encodeGitLabPath(path);
		const response = await this.request(
			"GET",
			`${GITLAB_API_V4}/projects/${this.projectId}/repository/files/${encodedPath}/raw`,
			params,
		);
		return response.text;
	}

	/** Get file metadata (includes last_commit_id, content_sha256). */
	async getFileMetadata(path: string, ref?: string): Promise<GitLabFileMeta> {
		const params: Record<string, string> = {};
		if (ref) params.ref = ref;

		const encodedPath = encodeGitLabPath(path);
		return this.get<GitLabFileMeta>(
			`${GITLAB_API_V4}/projects/${this.projectId}/repository/files/${encodedPath}`,
			params,
		);
	}

	// ── Commits ─────────────────────────────────────────────

	/** Get the latest commit on a branch. */
	async getLatestCommit(ref?: string): Promise<GitLabCommit> {
		const params: Record<string, string> = { per_page: "1" };
		if (ref) params.ref_name = ref;

		const commits = await this.get<GitLabCommit[]>(
			`${GITLAB_API_V4}/projects/${this.projectId}/repository/commits`,
			params,
		);
		if (commits.length === 0) {
			throw new Error("No commits found on branch");
		}
		return commits[0];
	}

	/**
	 * Create an atomic commit with multiple file actions.
	 * This is the primary mechanism for pushing changes via REST API.
	 */
	async createCommit(
		request: GitLabCreateCommitRequest,
	): Promise<GitLabCommit> {
		return this.post<GitLabCommit>(
			`${GITLAB_API_V4}/projects/${this.projectId}/repository/commits`,
			request,
		);
	}

	// ── HTTP helpers ────────────────────────────────────────

	private async get<T>(
		path: string,
		params?: Record<string, string>,
	): Promise<T> {
		const response = await this.request("GET", path, params);
		return response.json as T;
	}

	private async post<T>(
		path: string,
		body: unknown,
	): Promise<T> {
		const response = await this.request("POST", path, undefined, body);
		return response.json as T;
	}

	private async request(
		method: string,
		path: string,
		params?: Record<string, string>,
		body?: unknown,
	): Promise<RequestUrlResponse> {
		let url = `${this.baseUrl}${path}`;
		if (params) {
			const searchParams = new URLSearchParams(params);
			url += `?${searchParams.toString()}`;
		}

		console.debug("[GitLab Connector] HTTP request", {
			method,
			url,
			tokenPresent: this.token.length > 0,
		});

		const requestParams: RequestUrlParam = {
			url,
			method,
			headers: {
				"PRIVATE-TOKEN": this.token,
				"Content-Type": "application/json",
			},
			throw: false,
		};

		if (body) {
			requestParams.body = JSON.stringify(body);
		}

		const response = await requestUrl(requestParams);

		console.debug("[GitLab Connector] HTTP response", {
			status: response.status,
			...(response.status >= 400 && { body: response.text }),
		});

		if (response.status >= 400) {
			const errorBody = response.json as GitLabErrorResponse | undefined;
			const msg =
				errorBody?.message ??
				errorBody?.error ??
				`HTTP ${response.status}`;
			const errorMessage =
				typeof msg === "string" ? msg : JSON.stringify(msg);
			throw new GitLabApiError(
				`GitLab API error (${response.status}): ${errorMessage}`,
				response.status,
			);
		}

		return response;
	}
}

/** Typed error for GitLab API failures. */
export class GitLabApiError extends Error {
	constructor(
		message: string,
		public readonly statusCode: number,
	) {
		super(message);
		this.name = "GitLabApiError";
	}

	/** True if this is a 409 Conflict or 400 indicating a push conflict. */
	get isConflict(): boolean {
		return this.statusCode === 409 || this.statusCode === 400;
	}

	/** True if the token is invalid or expired. */
	get isAuthError(): boolean {
		return this.statusCode === 401 || this.statusCode === 403;
	}
}
