/**
 * Utilities for filtering files to only the .md files within
 * the user-configured subfolders.
 */

import type { TFile, Vault } from "obsidian";
import { normalizePath } from "obsidian";
import { isMarkdownFile, ensureTrailingSlash } from "../utils/path";

/**
 * Get all markdown files in the vault that are inside the given subfolder.
 * Uses Obsidian's file index — does NOT include files in hidden directories.
 */
export function getVaultMdFiles(
	vault: Vault,
	vaultSubfolder: string,
): TFile[] {
	const allMd = vault.getMarkdownFiles();
	if (!vaultSubfolder) return allMd;

	const prefix = ensureTrailingSlash(vaultSubfolder);
	return allMd.filter((f) => f.path.startsWith(prefix));
}

/**
 * Get all markdown file paths in the vault subfolder, including files
 * inside hidden directories (e.g. .github/, .agents/) that Obsidian's
 * indexer does not track.
 *
 * Returns vault-relative paths (same format as TFile.path).
 */
export async function getAllVaultMdFilePaths(
	vault: Vault,
	vaultSubfolder: string,
): Promise<string[]> {
	const result: string[] = [];
	const seen = new Set<string>();
	const prefix = vaultSubfolder ? ensureTrailingSlash(vaultSubfolder) : "";

	// Start with Obsidian's indexed files (faster, covers non-hidden paths)
	for (const f of vault.getMarkdownFiles()) {
		if (!prefix || f.path.startsWith(prefix)) {
			result.push(f.path);
			seen.add(f.path);
		}
	}

	// Also scan via the adapter to pick up hidden directories
	const scanRoot = vaultSubfolder ? normalizePath(vaultSubfolder) : "";
	try {
		await scanAdapterForMd(vault, scanRoot, seen, result);
	} catch {
		// Subfolder doesn't exist or adapter unavailable — indexed files only
	}

	return result;
}

/**
 * Recursively list .md files under `dir` using the vault adapter,
 * skipping paths already in `seen`.
 */
async function scanAdapterForMd(
	vault: Vault,
	dir: string,
	seen: Set<string>,
	result: string[],
): Promise<void> {
	let listed: { files: string[]; folders: string[] };
	try {
		listed = await vault.adapter.list(dir);
	} catch {
		return; // Directory doesn't exist or is unreadable
	}

	for (const file of listed.files) {
		if (isMarkdownFile(file) && !seen.has(file)) {
			result.push(file);
			seen.add(file);
		}
	}

	for (const folder of listed.folders) {
		await scanAdapterForMd(vault, folder, seen, result);
	}
}

/**
 * Filter a list of remote paths to only markdown files inside the subfolder.
 */
export function filterRemoteMdFiles(
	paths: string[],
	subfolder: string,
): string[] {
	return paths.filter(
		(p) => isMarkdownFile(p) && (!subfolder || p.startsWith(ensureTrailingSlash(subfolder))),
	);
}
