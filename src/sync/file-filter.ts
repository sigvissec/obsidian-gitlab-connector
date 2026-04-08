/**
 * Utilities for filtering files to only the .md files within
 * the user-configured subfolders.
 */

import type { TFile, Vault } from "obsidian";
import { isMarkdownFile, isInSubfolder, ensureTrailingSlash } from "../utils/path";

/**
 * Get all markdown files in the vault that are inside the given subfolder.
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
 * Filter a list of remote paths to only markdown files inside the subfolder.
 */
export function filterRemoteMdFiles(
	paths: string[],
	subfolder: string,
): string[] {
	return paths.filter(
		(p) => isMarkdownFile(p) && isInSubfolder(p, subfolder),
	);
}
