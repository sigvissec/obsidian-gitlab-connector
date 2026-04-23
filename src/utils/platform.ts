import { Platform } from "obsidian";

/**
 * Platform detection helpers that centralise Obsidian's Platform API
 * so the rest of the codebase doesn't import it directly.
 */

export function isMobile(): boolean {
	return Platform.isMobile;
}
