import { normalizePath } from "obsidian";
import { MARKDOWN_EXTENSION } from "../constants";

/**
 * Path manipulation utilities.
 *
 * All paths inside this plugin use forward slashes and are relative
 * to either the vault root or the repo root — never absolute OS paths.
 */

/** Returns true if the path ends with .md (case-insensitive). */
export function isMarkdownFile(path: string): boolean {
	return path.toLowerCase().endsWith(MARKDOWN_EXTENSION);
}

/** Returns true if `path` is inside `subfolder` (or if subfolder is empty). */
export function isInSubfolder(path: string, subfolder: string): boolean {
	if (!subfolder) return true;
	const normalized = ensureTrailingSlash(subfolder);
	return path.startsWith(normalized);
}

/**
 * Convert a remote repo path to the corresponding vault path.
 *
 * Example:
 *   remotePathToVaultPath("notes/daily/2024-01-01.md", "notes/", "gitlab-notes/")
 *   → "gitlab-notes/daily/2024-01-01.md"
 */
export function remotePathToVaultPath(
	remotePath: string,
	remoteSubfolder: string,
	vaultSubfolder: string,
): string {
	let relative = remotePath;
	if (remoteSubfolder) {
		const prefix = ensureTrailingSlash(remoteSubfolder);
		if (relative.startsWith(prefix)) {
			relative = relative.slice(prefix.length);
		}
	}
	const vaultPath = vaultSubfolder
		? `${ensureTrailingSlash(vaultSubfolder)}${relative}`
		: relative;
	return normalizePath(vaultPath);
}

/**
 * Convert a vault path to the corresponding remote repo path.
 *
 * Example:
 *   vaultPathToRemotePath("gitlab-notes/daily/2024-01-01.md", "gitlab-notes/", "notes/")
 *   → "notes/daily/2024-01-01.md"
 */
export function vaultPathToRemotePath(
	vaultPath: string,
	vaultSubfolder: string,
	remoteSubfolder: string,
): string {
	let relative = vaultPath;
	if (vaultSubfolder) {
		const prefix = ensureTrailingSlash(vaultSubfolder);
		if (relative.startsWith(prefix)) {
			relative = relative.slice(prefix.length);
		}
	}
	if (remoteSubfolder) {
		return `${ensureTrailingSlash(remoteSubfolder)}${relative}`;
	}
	return relative;
}

/** Strip the subfolder prefix from a path, returning just the relative portion. */
export function stripSubfolder(path: string, subfolder: string): string {
	if (!subfolder) return path;
	const prefix = ensureTrailingSlash(subfolder);
	if (path.startsWith(prefix)) {
		return path.slice(prefix.length);
	}
	return path;
}

/** Ensure a folder string ends with a trailing slash (unless empty). */
export function ensureTrailingSlash(folder: string): string {
	if (!folder) return "";
	return folder.endsWith("/") ? folder : `${folder}/`;
}

/** Remove trailing slash. */
export function removeTrailingSlash(folder: string): string {
	if (folder.endsWith("/")) {
		return folder.slice(0, -1);
	}
	return folder;
}

/**
 * URL-encode a file path for use in GitLab API URLs.
 * GitLab requires `/` to be encoded as `%2F`.
 */
export function encodeGitLabPath(path: string): string {
	return encodeURIComponent(path);
}
