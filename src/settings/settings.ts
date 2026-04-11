import { SyncMode, SyncTrigger } from "../types";
import {
	DEFAULT_GITLAB_URL,
	DEFAULT_BRANCH,
	DEFAULT_WORKING_BRANCH,
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
	/** Project path (e.g. "user/repo") or numeric project ID. */
	projectPath: string;
	/** Remote branch to read from (source of truth for pulls). */
	branch: string;
	/** Branch that local changes are pushed to. Created from `branch` if it doesn't exist. */
	workingBranch: string;

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

	// ── Hidden directory remapping ──────────────────────────
	/**
	 * When true, dot-prefixed remote directory names are remapped to
	 * underscore-prefixed names in the vault (e.g. .github/ → _github/)
	 * so Obsidian's file explorer shows them. Push transparently reverses
	 * the rename. The mapping is auto-populated on pull.
	 */
	remapHiddenDirs: boolean;
	/**
	 * Auto-populated map of remote dot-dir names → vault underscore names.
	 * Example: { ".github": "_github", ".agents": "_agents" }
	 * Populated automatically during pulls. Only mapped entries are
	 * reverse-translated on push, so legitimate _-prefixed vault directories
	 * are never accidentally pushed as .-prefixed remote paths.
	 */
	dotDirMap: Record<string, string>;
}

/** Sensible defaults applied when no saved settings exist yet. */
export const DEFAULT_SETTINGS: GitLabConnectorSettings = {
	gitlabUrl: DEFAULT_GITLAB_URL,
	projectPath: "",
	branch: DEFAULT_BRANCH,
	workingBranch: DEFAULT_WORKING_BRANCH,

	remoteSubfolder: "",
	vaultSubfolder: "gitlab-notes",

	syncMode: SyncMode.ISOMORPHIC_GIT,
	syncTrigger: SyncTrigger.MANUAL,
	syncIntervalMinutes: DEFAULT_SYNC_INTERVAL_MINUTES,

	cloneDepth: DEFAULT_CLONE_DEPTH,

	authorName: "",
	authorEmail: "",

	remapHiddenDirs: true,
	dotDirMap: {},
};
