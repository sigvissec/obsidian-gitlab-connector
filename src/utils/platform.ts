import { Platform } from "obsidian";

/**
 * Platform detection helpers that centralise Obsidian's Platform API
 * so the rest of the codebase doesn't import it directly.
 */

export function isMobile(): boolean {
	return Platform.isMobile;
}

export function isDesktop(): boolean {
	return Platform.isDesktop;
}

export function isAndroid(): boolean {
	return Platform.isAndroidApp;
}

export function isIos(): boolean {
	return Platform.isIosApp;
}

/** Human-readable platform label for logs / notices. */
export function platformLabel(): string {
	if (Platform.isAndroidApp) return "Android";
	if (Platform.isIosApp) return "iOS";
	if (Platform.isMacOS) return "macOS";
	if (Platform.isWin) return "Windows";
	if (Platform.isLinux) return "Linux";
	return "Unknown";
}
