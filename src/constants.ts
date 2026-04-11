/**
 * Default values and constants for the GitLab Connector plugin.
 */

/** Default GitLab instance URL. */
export const DEFAULT_GITLAB_URL = "https://gitlab.com";

/** Default git branch name (the remote source branch to read from). */
export const DEFAULT_BRANCH = "main";

/** Default working branch where local changes are pushed. */
export const DEFAULT_WORKING_BRANCH = "obsidian-plugin";

/** Default sync interval in minutes (when auto-timer is enabled). */
export const DEFAULT_SYNC_INTERVAL_MINUTES = 5;

/** Minimum sync interval in minutes. */
export const MIN_SYNC_INTERVAL_MINUTES = 1;

/** Maximum sync interval in minutes. */
export const MAX_SYNC_INTERVAL_MINUTES = 60;

/** Default clone depth for isomorphic-git. */
export const DEFAULT_CLONE_DEPTH = 1;

/** Minimum clone depth. */
export const MIN_CLONE_DEPTH = 1;

/** Maximum clone depth. */
export const MAX_CLONE_DEPTH = 100;

/** Name of the LightningFS IndexedDB database. */
export const LIGHTNING_FS_DB_NAME = "gitlab-connector-repo";

/** Virtual directory path for the git repo inside LightningFS. */
export const GIT_REPO_DIR = "/repo";

/** Debounce delay in ms for file-change triggered sync. */
export const FILE_CHANGE_DEBOUNCE_MS = 5000;

/** Maximum retries for network operations. */
export const MAX_NETWORK_RETRIES = 3;

/** Base delay in ms for exponential backoff. */
export const BACKOFF_BASE_MS = 1000;

/** GitLab API version prefix. */
export const GITLAB_API_V4 = "/api/v4";

/** Maximum number of items per page in GitLab API requests. */
export const GITLAB_MAX_PER_PAGE = 100;

/** File extension we sync. */
export const MARKDOWN_EXTENSION = ".md";

/** Plugin display name (for notices/logs). */
export const PLUGIN_DISPLAY_NAME = "GitLab Connector";

/** SecretStorage key for the GitLab Personal Access Token. */
export const PAT_SECRET_KEY = "gitlab-connector-pat";
