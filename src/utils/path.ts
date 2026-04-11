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

/**
 * Reject paths containing traversal sequences (`..`) or absolute prefixes.
 * Protects against malicious remote file paths that could escape the
 * intended vault subfolder or git working directory.
 */
export function assertSafePath(path: string): void {
	const segments = path.split("/");
	if (segments.includes("..")) {
		throw new Error(`Path traversal rejected: ${path}`);
	}
	if (path.startsWith("/")) {
		throw new Error(`Absolute path rejected: ${path}`);
	}
}

/** Returns true if `path` is inside `subfolder` (or if subfolder is empty). */
export function isInSubfolder(path: string, subfolder: string): boolean {
	if (!subfolder) return true;
	const normalized = ensureTrailingSlash(subfolder);
	return path.startsWith(normalized);
}

/**
 * Apply a dot-dir mapping to the directory components of a relative path
 * (remote → vault direction).
 *
 * Each directory segment (all parts except the last filename) that has an
 * entry in `map` is replaced with the mapped value.
 * Example with map = { ".github": "_github" }:
 *   ".github/agents/foo.md" → "_github/agents/foo.md"
 */
function applyDotDirMap(
	relative: string,
	map: Record<string, string>,
): string {
	if (Object.keys(map).length === 0) return relative;
	const parts = relative.split("/");
	for (let i = 0; i < parts.length - 1; i++) {
		if (map[parts[i]]) parts[i] = map[parts[i]];
	}
	return parts.join("/");
}

/**
 * Reverse a dot-dir mapping for the directory components of a relative path
 * (vault → remote direction).
 *
 * Builds an inverse lookup and replaces only directory segments whose vault
 * name appears in the map values. Segments NOT in the map pass through
 * unchanged — so legitimately `_`-prefixed vault directories are never
 * accidentally pushed as `.`-prefixed remote paths.
 * Example with map = { ".github": "_github" }:
 *   "_github/agents/foo.md" → ".github/agents/foo.md"
 *   "_templates/readme.md"  → "_templates/readme.md"  (not in map)
 */
function reverseDotDirMap(
	relative: string,
	map: Record<string, string>,
): string {
	if (Object.keys(map).length === 0) return relative;
	const reverse: Record<string, string> = {};
	for (const [remote, vault] of Object.entries(map)) reverse[vault] = remote;
	const parts = relative.split("/");
	for (let i = 0; i < parts.length - 1; i++) {
		if (reverse[parts[i]]) parts[i] = reverse[parts[i]];
	}
	return parts.join("/");
}

/**
 * Convert a remote repo path to the corresponding vault path.
 *
 * When `dotDirMap` is provided, dot-prefixed directory segments are renamed
 * to their underscore-prefixed vault equivalents so Obsidian shows them.
 *
 * Example (no map):
 *   remotePathToVaultPath("notes/daily/2024-01-01.md", "notes/", "gitlab-notes/")
 *   → "gitlab-notes/daily/2024-01-01.md"
 *
 * Example (with map = { ".github": "_github" }):
 *   remotePathToVaultPath(".github/foo.md", "", "notes/", map)
 *   → "notes/_github/foo.md"
 */
export function remotePathToVaultPath(
	remotePath: string,
	remoteSubfolder: string,
	vaultSubfolder: string,
	dotDirMap: Record<string, string> = {},
): string {
	assertSafePath(remotePath);
	let relative = remotePath;
	if (remoteSubfolder) {
		const prefix = ensureTrailingSlash(remoteSubfolder);
		if (relative.startsWith(prefix)) {
			relative = relative.slice(prefix.length);
		}
	}
	relative = applyDotDirMap(relative, dotDirMap);
	const vaultPath = vaultSubfolder
		? `${ensureTrailingSlash(vaultSubfolder)}${relative}`
		: relative;
	return normalizePath(vaultPath);
}

/**
 * Convert a vault path to the corresponding remote repo path.
 *
 * When `dotDirMap` is provided, underscore-prefixed directory segments that
 * appear in the map are renamed back to their original dot-prefixed names.
 * Segments not in the map pass through unchanged.
 *
 * Example (no map):
 *   vaultPathToRemotePath("gitlab-notes/daily/2024-01-01.md", "gitlab-notes/", "notes/")
 *   → "notes/daily/2024-01-01.md"
 *
 * Example (with map = { ".github": "_github" }):
 *   vaultPathToRemotePath("notes/_github/foo.md", "notes/", "", map)
 *   → ".github/foo.md"
 */
export function vaultPathToRemotePath(
	vaultPath: string,
	vaultSubfolder: string,
	remoteSubfolder: string,
	dotDirMap: Record<string, string> = {},
): string {
	assertSafePath(vaultPath);
	let relative = vaultPath;
	if (vaultSubfolder) {
		const prefix = ensureTrailingSlash(vaultSubfolder);
		if (relative.startsWith(prefix)) {
			relative = relative.slice(prefix.length);
		}
	}
	relative = reverseDotDirMap(relative, dotDirMap);
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
