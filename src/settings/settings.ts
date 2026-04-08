import { SyncMode, SyncTrigger } from "../types";
import {
	DEFAULT_GITLAB_URL,
	DEFAULT_BRANCH,
	DEFAULT_SYNC_INTERVAL_MINUTES,
	DEFAULT_CLONE_DEPTH,
} from "../constants";

/**
 * All user-configurable settings for the GitLab Connector plugin.
 */
export interface GitLabConnectorSettings {
	// ── Connection ──────────────────────────────────────────
	/** GitLab instance base URL (e.g. https://gitlab.com). */
	gitlabUrl: string;
	/** Personal Access Token with at least read_repository + write_repository scopes. */
	personalAccessToken: string;
	/** Project path (e.g. "user/repo") or numeric project ID. */
	projectPath: string;
	/** Branch to sync against. */
	branch: string;

	// ── Sync scope ──────────────────────────────────────────
	/** Subfolder inside the GitLab repo to sync (e.g. "notes/"). Empty = repo root. */
	remoteSubfolder: string;
	/** Subfolder inside the Obsidian vault to sync into (e.g. "gitlab-notes/"). */
	vaultSubfolder: string;

	// ── Sync behaviour ──────────────────────────────────────
	/** Primary sync backend. */
	syncMode: SyncMode;
	/** How sync is triggered. */
	syncTrigger: SyncTrigger;
	/** Interval in minutes when syncTrigger is AUTO_TIMER. */
	syncIntervalMinutes: number;

	// ── Git (isomorphic-git mode) ───────────────────────────
	/** Shallow clone depth. 1 = smallest download. */
	cloneDepth: number;

	// ── Author info (used for commits) ──────────────────────
	authorName: string;
	authorEmail: string;
}

/** Sensible defaults applied when no saved settings exist yet. */
export const DEFAULT_SETTINGS: GitLabConnectorSettings = {
	gitlabUrl: DEFAULT_GITLAB_URL,
	personalAccessToken: "",
	projectPath: "",
	branch: DEFAULT_BRANCH,

	remoteSubfolder: "",
	vaultSubfolder: "gitlab-notes",

	syncMode: SyncMode.ISOMORPHIC_GIT,
	syncTrigger: SyncTrigger.MANUAL,
	syncIntervalMinutes: DEFAULT_SYNC_INTERVAL_MINUTES,

	cloneDepth: DEFAULT_CLONE_DEPTH,

	authorName: "",
	authorEmail: "",
};
