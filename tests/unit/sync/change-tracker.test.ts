/**
 * Unit tests for detectChanges().
 *
 * Each test builds a minimal fake Vault (no Obsidian runtime required),
 * a fake StateManager backed by a plain object, and a fake remote file list,
 * then asserts the correct ChangeDetectionResult categories.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { detectChanges } from "../../../src/sync/change-tracker";
import { sha256 } from "../../../src/utils/hash";
import type { RemoteFileInfo } from "../../../src/types";
import type { Vault } from "obsidian";
import type { StateManager, FileSyncState } from "../../../src/sync/state-manager";

// ── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Build a minimal Vault stub from a flat { path → content } map.
 *
 * getMarkdownFiles() returns nothing (hidden-dir scan is delegated to
 * adapter.list which this mock fully implements via recursive listing).
 */
function makeVault(files: Record<string, string>): Vault {
	return {
		getMarkdownFiles: () => [],
		adapter: {
			read: async (path: string) => {
				const content = files[path];
				if (content === undefined) throw new Error(`File not found: ${path}`);
				return content;
			},
			list: async (dir: string) => {
				const prefix = dir ? (dir.endsWith("/") ? dir : `${dir}/`) : "";
				const resultFiles: string[] = [];
				const subfoldersSeen = new Set<string>();
				const resultFolders: string[] = [];

				for (const p of Object.keys(files)) {
					if (!prefix || p.startsWith(prefix)) {
						const rest = prefix ? p.slice(prefix.length) : p;
						const slashIdx = rest.indexOf("/");
						if (slashIdx === -1) {
							resultFiles.push(p);
						} else {
							const sub = prefix + rest.slice(0, slashIdx);
							if (!subfoldersSeen.has(sub)) {
								subfoldersSeen.add(sub);
								resultFolders.push(sub);
							}
						}
					}
				}
				return { files: resultFiles, folders: resultFolders };
			},
		},
	} as unknown as Vault;
}

/** Build a minimal StateManager stub backed by a plain object. */
function makeStateManager(
	state: Record<string, FileSyncState>,
): StateManager {
	return {
		getAllTrackedPaths: () => Object.keys(state),
		getFileState: (path: string) => state[path],
	} as unknown as StateManager;
}

/** Remote file list entry. */
function rf(path: string, sha: string): RemoteFileInfo {
	return { path, sha };
}

/** Compute the hash of a string synchronously-ish (await at top of test). */
async function h(content: string): Promise<string> {
	return sha256(content);
}

// Pre-computed hashes for common test strings
let hashA: string;
let hashB: string;

beforeAll(async () => {
	hashA = await h("content-a");
	hashB = await h("content-b");
});

// ── No changes ───────────────────────────────────────────────────────────────

describe("no changes", () => {
	it("returns empty result when local and remote match state", async () => {
		const vault = makeVault({ "notes/a.md": "content-a" });
		const sm = makeStateManager({
			"notes/a.md": {
				contentHash: hashA,
				baseContent: "content-a",
				remoteSha: "sha-a",
				lastSynced: 0,
			},
		});
		const remoteFiles = [rf("notes/a.md", "sha-a")];

		const result = await detectChanges(
			vault, sm, remoteFiles,
			"", "",
		);

		expect(result.localChanges).toHaveLength(0);
		expect(result.remoteChanges).toHaveLength(0);
		expect(result.bothChanged).toHaveLength(0);
	});
});

// ── Local changes ────────────────────────────────────────────────────────────

describe("local changes", () => {
	it("detects a new local file with no state as CREATED", async () => {
		const vault = makeVault({ "notes/new.md": "hello" });
		const sm = makeStateManager({});
		const remoteFiles: RemoteFileInfo[] = [];

		const result = await detectChanges(
			vault, sm, remoteFiles,
			"", "",
		);

		expect(result.localChanges).toHaveLength(1);
		expect(result.localChanges[0]).toMatchObject({
			path: "notes/new.md",
			type: "created",
		});
		expect(result.remoteChanges).toHaveLength(0);
		expect(result.bothChanged).toHaveLength(0);
	});

	it("detects a locally modified file as MODIFIED", async () => {
		const vault = makeVault({ "notes/a.md": "content-b" }); // edited!
		const sm = makeStateManager({
			"notes/a.md": {
				contentHash: hashA, // hash of original "content-a"
				baseContent: "content-a",
				remoteSha: "sha-a",
				lastSynced: 0,
			},
		});
		const remoteFiles = [rf("notes/a.md", "sha-a")]; // remote unchanged

		const result = await detectChanges(
			vault, sm, remoteFiles,
			"", "",
		);

		expect(result.localChanges).toHaveLength(1);
		expect(result.localChanges[0]).toMatchObject({
			path: "notes/a.md",
			type: "modified",
		});
		expect(result.remoteChanges).toHaveLength(0);
		expect(result.bothChanged).toHaveLength(0);
	});

	it("detects a locally deleted file as DELETED", async () => {
		const vault = makeVault({}); // file gone from vault
		const sm = makeStateManager({
			"notes/a.md": {
				contentHash: hashA,
				baseContent: "content-a",
				remoteSha: "sha-a",
				lastSynced: 0,
			},
		});
		const remoteFiles = [rf("notes/a.md", "sha-a")]; // still on remote

		const result = await detectChanges(
			vault, sm, remoteFiles,
			"", "",
		);

		expect(result.localChanges).toHaveLength(1);
		expect(result.localChanges[0]).toMatchObject({
			path: "notes/a.md",
			type: "deleted",
		});
		expect(result.remoteChanges).toHaveLength(0);
		expect(result.bothChanged).toHaveLength(0);
	});
});

// ── Remote changes ───────────────────────────────────────────────────────────

describe("remote changes", () => {
	it("detects a new remote file with no state as CREATED", async () => {
		const vault = makeVault({});
		const sm = makeStateManager({});
		const remoteFiles = [rf("notes/new.md", "sha-new")];

		const result = await detectChanges(
			vault, sm, remoteFiles,
			"", "",
		);

		expect(result.remoteChanges).toHaveLength(1);
		expect(result.remoteChanges[0]).toMatchObject({
			path: "notes/new.md",
			type: "created",
		});
		expect(result.localChanges).toHaveLength(0);
		expect(result.bothChanged).toHaveLength(0);
	});

	it("detects a remotely modified file (SHA changed) as MODIFIED", async () => {
		const vault = makeVault({ "notes/a.md": "content-a" });
		const sm = makeStateManager({
			"notes/a.md": {
				contentHash: hashA,
				baseContent: "content-a",
				remoteSha: "sha-a",
				lastSynced: 0,
			},
		});
		const remoteFiles = [rf("notes/a.md", "sha-a-new")]; // remote SHA advanced

		const result = await detectChanges(
			vault, sm, remoteFiles,
			"", "",
		);

		expect(result.remoteChanges).toHaveLength(1);
		expect(result.remoteChanges[0]).toMatchObject({
			path: "notes/a.md",
			type: "modified",
		});
		expect(result.localChanges).toHaveLength(0);
		expect(result.bothChanged).toHaveLength(0);
	});

	it("detects a remotely deleted file as DELETED", async () => {
		const vault = makeVault({ "notes/a.md": "content-a" });
		const sm = makeStateManager({
			"notes/a.md": {
				contentHash: hashA,
				baseContent: "content-a",
				remoteSha: "sha-a",
				lastSynced: 0,
			},
		});
		const remoteFiles: RemoteFileInfo[] = []; // file gone from remote

		const result = await detectChanges(
			vault, sm, remoteFiles,
			"", "",
		);

		expect(result.remoteChanges).toHaveLength(1);
		expect(result.remoteChanges[0]).toMatchObject({
			path: "notes/a.md",
			type: "deleted",
		});
		expect(result.localChanges).toHaveLength(0);
		expect(result.bothChanged).toHaveLength(0);
	});
});

// ── Both changed ─────────────────────────────────────────────────────────────

describe("bothChanged", () => {
	it("places a path in bothChanged when both local and remote differ from state", async () => {
		const vault = makeVault({ "notes/a.md": "content-b" }); // local edited
		const sm = makeStateManager({
			"notes/a.md": {
				contentHash: hashA, // original hash
				baseContent: "content-a",
				remoteSha: "sha-a",
				lastSynced: 0,
			},
		});
		const remoteFiles = [rf("notes/a.md", "sha-a-new")]; // remote also changed

		const result = await detectChanges(
			vault, sm, remoteFiles,
			"", "",
		);

		expect(result.bothChanged).toContain("notes/a.md");
		expect(result.localChanges).toHaveLength(0);
		expect(result.remoteChanges).toHaveLength(0);
	});
});

// ── dotDirMap regression ─────────────────────────────────────────────────────

describe("dotDirMap regression", () => {
	it("correctly matches vault _github/ file to remote .github/ state key", async () => {
		// This is the core regression: after remapping, local file is at _github/foo.md
		// but state and remote use .github/foo.md.  detectChanges must bridge the two.
		const vault = makeVault({ "_github/foo.md": "content-a" });
		const sm = makeStateManager({
			".github/foo.md": {
				contentHash: hashA,
				baseContent: "content-a",
				remoteSha: "sha-a",
				lastSynced: 0,
			},
		});
		const remoteFiles = [rf(".github/foo.md", "sha-a")];
		const dotDirMap = { ".github": "_github" };

		const result = await detectChanges(
			vault, sm, remoteFiles,
			"", "", dotDirMap,
		);

		// No changes — vault _github/foo.md maps to .github/foo.md which matches state
		expect(result.localChanges).toHaveLength(0);
		expect(result.remoteChanges).toHaveLength(0);
		expect(result.bothChanged).toHaveLength(0);
	});

	it("detects a local edit in a remapped directory as MODIFIED", async () => {
		const vault = makeVault({ "_github/foo.md": "content-b" }); // edited
		const sm = makeStateManager({
			".github/foo.md": {
				contentHash: hashA, // original
				baseContent: "content-a",
				remoteSha: "sha-a",
				lastSynced: 0,
			},
		});
		const remoteFiles = [rf(".github/foo.md", "sha-a")]; // remote unchanged
		const dotDirMap = { ".github": "_github" };

		const result = await detectChanges(
			vault, sm, remoteFiles,
			"", "", dotDirMap,
		);

		expect(result.localChanges).toHaveLength(1);
		expect(result.localChanges[0]).toMatchObject({
			path: ".github/foo.md",
			type: "modified",
		});
		expect(result.remoteChanges).toHaveLength(0);
		expect(result.bothChanged).toHaveLength(0);
	});

	it("does NOT reverse-map an unmapped _templates/ directory", async () => {
		// _templates/ is NOT in dotDirMap — it should remain as-is on remote
		const vault = makeVault({ "_templates/readme.md": "content-a" });
		const sm = makeStateManager({
			"_templates/readme.md": {
				contentHash: hashA,
				baseContent: "content-a",
				remoteSha: "sha-a",
				lastSynced: 0,
			},
		});
		const remoteFiles = [rf("_templates/readme.md", "sha-a")];
		const dotDirMap = { ".github": "_github" }; // _templates NOT in map

		const result = await detectChanges(
			vault, sm, remoteFiles,
			"", "", dotDirMap,
		);

		expect(result.localChanges).toHaveLength(0);
		expect(result.remoteChanges).toHaveLength(0);
		expect(result.bothChanged).toHaveLength(0);
	});
});
