/**
 * Unit tests for path translation utilities.
 *
 * These are pure functions with no external dependencies.
 * Tests cover forward (remote→vault) and reverse (vault→remote) conversions,
 * dot-directory remapping, and subfolder stripping.
 */

import { describe, it, expect } from "vitest";
import { remotePathToVaultPath, vaultPathToRemotePath } from "./path";

// ── remotePathToVaultPath ────────────────────────────────────────────────────

describe("remotePathToVaultPath", () => {
	it("passes a simple path through unchanged with no subfolder or map", () => {
		expect(remotePathToVaultPath("notes/foo.md", "", "")).toBe("notes/foo.md");
	});

	it("strips the remote subfolder prefix", () => {
		expect(remotePathToVaultPath("notes/daily/2024-01-01.md", "notes/", "")).toBe(
			"daily/2024-01-01.md",
		);
	});

	it("prepends the vault subfolder", () => {
		expect(remotePathToVaultPath("foo.md", "", "vault-folder")).toBe(
			"vault-folder/foo.md",
		);
	});

	it("strips remote subfolder and prepends vault subfolder", () => {
		expect(
			remotePathToVaultPath("notes/daily/a.md", "notes/", "gitlab-notes"),
		).toBe("gitlab-notes/daily/a.md");
	});

	it("applies dotDirMap to directory segments (forward direction)", () => {
		const map = { ".github": "_github" };
		expect(remotePathToVaultPath(".github/foo.md", "", "", map)).toBe(
			"_github/foo.md",
		);
	});

	it("does not remap the filename itself, only directory segments", () => {
		const map = { ".github": "_github" };
		expect(remotePathToVaultPath(".github.md", "", "", map)).toBe(".github.md");
	});

	it("remaps nested hidden directories", () => {
		const map = { ".agents": "_agents" };
		expect(remotePathToVaultPath(".agents/tools/foo.md", "", "", map)).toBe(
			"_agents/tools/foo.md",
		);
	});

	it("remaps multiple directory levels when both are in the map", () => {
		const map = { ".github": "_github", ".agents": "_agents" };
		// Only the first directory segment of a path can be a top-level hidden dir;
		// this test checks that each segment is independently remapped.
		expect(remotePathToVaultPath(".github/sub/.agents/foo.md", "", "", map)).toBe(
			"_github/sub/_agents/foo.md",
		);
	});

	it("applies dotDirMap after stripping the remote subfolder", () => {
		const map = { ".github": "_github" };
		expect(
			remotePathToVaultPath("repo/.github/foo.md", "repo/", "", map),
		).toBe("_github/foo.md");
	});

	it("works with empty dotDirMap (no remapping)", () => {
		expect(remotePathToVaultPath(".github/foo.md", "", "", {})).toBe(
			".github/foo.md",
		);
	});

	it("strips trailing slash from remote subfolder gracefully", () => {
		// ensureTrailingSlash normalises the prefix before stripping
		expect(remotePathToVaultPath("notes/a.md", "notes", "")).toBe("a.md");
	});
});

// ── vaultPathToRemotePath ────────────────────────────────────────────────────

describe("vaultPathToRemotePath", () => {
	it("passes a simple path through unchanged with no subfolder or map", () => {
		expect(vaultPathToRemotePath("notes/foo.md", "", "")).toBe("notes/foo.md");
	});

	it("strips the vault subfolder prefix", () => {
		expect(vaultPathToRemotePath("vault-folder/foo.md", "vault-folder/", "")).toBe(
			"foo.md",
		);
	});

	it("prepends the remote subfolder", () => {
		expect(vaultPathToRemotePath("foo.md", "", "notes/")).toBe("notes/foo.md");
	});

	it("reverse-maps an underscore-prefixed directory to dot-prefixed (reverse direction)", () => {
		const map = { ".github": "_github" };
		expect(vaultPathToRemotePath("_github/foo.md", "", "", map)).toBe(
			".github/foo.md",
		);
	});

	it("does NOT reverse-map a directory that is not in the map", () => {
		const map = { ".github": "_github" };
		// _templates is NOT in the map — must pass through unchanged
		expect(vaultPathToRemotePath("_templates/readme.md", "", "", map)).toBe(
			"_templates/readme.md",
		);
	});

	it("does not remap the filename, only directory segments", () => {
		const map = { ".github": "_github" };
		expect(vaultPathToRemotePath("_github.md", "", "", map)).toBe("_github.md");
	});

	it("reverse-maps nested hidden directories", () => {
		const map = { ".agents": "_agents" };
		expect(vaultPathToRemotePath("_agents/tools/foo.md", "", "", map)).toBe(
			".agents/tools/foo.md",
		);
	});

	it("works with empty dotDirMap (no remapping)", () => {
		expect(vaultPathToRemotePath("_github/foo.md", "", "", {})).toBe(
			"_github/foo.md",
		);
	});

	it("strips trailing slash from vault subfolder gracefully", () => {
		expect(vaultPathToRemotePath("vault/a.md", "vault", "")).toBe("a.md");
	});
});

// ── Round-trip consistency ───────────────────────────────────────────────────

describe("path round-trip", () => {
	it("remote→vault→remote is identity with no subfolder", () => {
		const map = { ".github": "_github" };
		const remote = ".github/agents/foo.md";
		const vault = remotePathToVaultPath(remote, "", "", map);
		expect(vaultPathToRemotePath(vault, "", "", map)).toBe(remote);
	});

	it("remote→vault→remote is identity with both subfolders", () => {
		const map = { ".github": "_github" };
		const remote = "repo/.github/foo.md";
		const vault = remotePathToVaultPath(remote, "repo/", "vault/", map);
		expect(vaultPathToRemotePath(vault, "vault/", "repo/", map)).toBe(remote);
	});

	it("unmapped path is unchanged through both directions", () => {
		const map = { ".github": "_github" };
		const remote = "notes/daily/2024-01-01.md";
		const vault = remotePathToVaultPath(remote, "", "", map);
		expect(vaultPathToRemotePath(vault, "", "", map)).toBe(remote);
	});
});
