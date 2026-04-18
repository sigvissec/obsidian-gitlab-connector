/**
 * Minimal stub of the `obsidian` package for use in Vitest unit tests.
 *
 * The real `obsidian` module is a browser bundle that cannot be loaded in
 * a Node environment.  Only the APIs actually used by tested modules are
 * stubbed here.
 */

/** Normalise path separators: collapse duplicate slashes, convert backslashes. */
export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

/** Stub — tests should not instantiate Notice directly. */
export class Notice {
	constructor(_message: string) {}
}

/** Stub types used as type-only imports in tested files. */
export interface TFile {
	path: string;
}

export interface Vault {
	getMarkdownFiles(): TFile[];
	getFileByPath(path: string): TFile | null;
	adapter: {
		read(path: string): Promise<string>;
		list(dir: string): Promise<{ files: string[]; folders: string[] }>;
	};
}
