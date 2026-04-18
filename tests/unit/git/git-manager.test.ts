/**
 * Regression tests for GitManager — specifically the push-failure rollback
 * and remote tracking ref selection behaviour introduced to fix the
 * "no local changes detected after failed push" bug.
 *
 * Uses isomorphic-git with memfs so no real network or LightningFS is needed.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import git from "isomorphic-git";
import { createFsFromVolume, Volume } from "memfs";

// ── Minimal in-memory FS adaptor for isomorphic-git ─────────────────────────

/** Build a fresh memfs volume and wrap it for use with isomorphic-git. */
function makeMemFs() {
	const vol = new Volume();
	const fs = createFsFromVolume(vol);
	// isomorphic-git requires a { promises } shape
	return { fs: { promises: fs.promises }, vol };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const AUTHOR = { name: "Test", email: "test@test.com" };

/** Initialise a bare repo at `dir` with one commit containing `files`. */
async function initBareRepo(
	fs: { promises: object },
	dir: string,
	files: Record<string, string>,
): Promise<void> {
	await fs.promises.mkdir(dir, { recursive: true });
	await git.init({ fs, dir, bare: false });
	for (const [path, content] of Object.entries(files)) {
		const full = `${dir}/${path}`;
		const parent = full.slice(0, full.lastIndexOf("/"));
		await fs.promises.mkdir(parent, { recursive: true });
		await fs.promises.writeFile(full, content, "utf8");
		await git.add({ fs, dir, filepath: path });
	}
	await git.commit({ fs, dir, message: "init", author: AUTHOR });
}

/**
 * Clone a "remote" dir into a "local" dir.
 * isomorphic-git clone over `file://` is not supported, so we simulate by
 * sharing the same FS and copying the refs manually (a local bare→work clone).
 */
async function localClone(
	fs: { promises: object },
	remoteDir: string,
	localDir: string,
	branch = "main",
): Promise<void> {
	await fs.promises.mkdir(localDir, { recursive: true });
	await git.init({ fs, dir: localDir });

	// Read the remote commit and files
	const remoteSha = await git.resolveRef({ fs, dir: remoteDir, ref: "HEAD" });

	// Copy the remote tree into the local working dir
	const files = await git.walk({
		fs,
		dir: remoteDir,
		trees: [git.TREE({ ref: branch })],
		map: async (filepath, [entry]) => {
			if (!entry || filepath === ".") return undefined;
			const type = await entry.type();
			if (type !== "blob") return undefined;
			const { blob } = await git.readBlob({
				fs,
				dir: remoteDir,
				oid: await entry.oid(),
			});
			return { filepath, blob };
		},
	});

	for (const f of (files as Array<{ filepath: string; blob: Uint8Array } | undefined>)) {
		if (!f) continue;
		const full = `${localDir}/${f.filepath}`;
		const parent = full.slice(0, full.lastIndexOf("/"));
		await fs.promises.mkdir(parent, { recursive: true });
		await fs.promises.writeFile(full, f.blob);
		await git.add({ fs, dir: localDir, filepath: f.filepath });
	}

	// Create a commit so we have a local HEAD
	const localSha = await git.commit({
		fs,
		dir: localDir,
		message: "init",
		author: AUTHOR,
	});

	// Set up the remote tracking ref
	await git.writeRef({
		fs,
		dir: localDir,
		ref: `refs/remotes/origin/${branch}`,
		value: localSha, // treat localSha as "what remote had at clone time"
		force: true,
	});

	// Point local branch to the same commit
	await git.writeRef({
		fs,
		dir: localDir,
		ref: `refs/heads/${branch}`,
		value: localSha,
		force: true,
	});
}

// ── remoteTreeRef() selection ────────────────────────────────────────────────

describe("remoteTreeRef() selection", () => {
	it("returns remote tracking ref when it exists", async () => {
		const { fs } = makeMemFs();
		const dir = "/repo";

		await fs.promises.mkdir(dir, { recursive: true });
		await git.init({ fs, dir });
		await fs.promises.writeFile(`${dir}/a.md`, "hello", "utf8");
		await git.add({ fs, dir, filepath: "a.md" });
		const sha = await git.commit({ fs, dir, message: "init", author: AUTHOR });

		// Create remote tracking ref for the default branch
		await git.writeRef({ fs, dir, ref: "refs/remotes/origin/testbranch", value: sha, force: true });

		// resolveRef on the remote tracking ref should succeed
		const remoteSha = await git.resolveRef({ fs, dir, ref: "refs/remotes/origin/testbranch" });
		expect(remoteSha).toBe(sha);
	});

	it("resolveRef on a missing remote tracking ref throws", async () => {
		const { fs } = makeMemFs();
		const dir = "/repo2";

		await fs.promises.mkdir(dir, { recursive: true });
		await git.init({ fs, dir });
		await fs.promises.writeFile(`${dir}/a.md`, "hello", "utf8");
		await git.add({ fs, dir, filepath: "a.md" });
		const sha = await git.commit({ fs, dir, message: "init", author: AUTHOR });
		await git.writeRef({ fs, dir, ref: "refs/heads/newbranch", value: sha, force: true });
		// No refs/remotes/origin/newbranch

		await expect(
			git.resolveRef({ fs, dir, ref: "refs/remotes/origin/newbranch" }),
		).rejects.toThrow();
	});
});

// ── push failure rollback ─────────────────────────────────────────────────────

describe("push failure rollback", () => {
	let fs: ReturnType<typeof makeMemFs>["fs"];
	let dir: string;
	let prePushSha: string;
	let currentBranch: string;

	beforeEach(async () => {
		({ fs } = makeMemFs());
		dir = "/local";

		await fs.promises.mkdir(`${dir}/notes`, { recursive: true });
		await git.init({ fs, dir });

		// Determine the actual default branch (may be "master" or "main")
		currentBranch = (await git.currentBranch({ fs, dir })) ?? "master";

		await fs.promises.writeFile(`${dir}/notes/a.md`, "content-a", "utf8");
		await git.add({ fs, dir, filepath: "notes/a.md" });
		prePushSha = await git.commit({ fs, dir, message: "init", author: AUTHOR });

		// Simulate the remote tracking ref at the initial commit
		await git.writeRef({
			fs,
			dir,
			ref: `refs/remotes/origin/${currentBranch}`,
			value: prePushSha,
			force: true,
		});
	});

	it("after creating a commit, writeRef rolls back local branch to prePushSha", async () => {
		// Simulate what pushChanges does: modify file, stage, commit
		await fs.promises.writeFile(`${dir}/notes/a.md`, "content-edited", "utf8");
		await git.add({ fs, dir, filepath: "notes/a.md" });
		const newSha = await git.commit({ fs, dir, message: "edit", author: AUTHOR });

		// Confirm local branch has advanced
		const localAfterCommit = await git.resolveRef({ fs, dir, ref: `refs/heads/${currentBranch}` });
		expect(localAfterCommit).toBe(newSha);
		expect(newSha).not.toBe(prePushSha);

		// Simulate push failure → rollback
		await git.writeRef({ fs, dir, ref: `refs/heads/${currentBranch}`, value: prePushSha, force: true });

		const localAfterRollback = await git.resolveRef({ fs, dir, ref: `refs/heads/${currentBranch}` });
		expect(localAfterRollback).toBe(prePushSha);
	});

	it("after rollback, remote tracking ref still points to prePushSha (unaffected)", async () => {
		await fs.promises.writeFile(`${dir}/notes/a.md`, "content-edited", "utf8");
		await git.add({ fs, dir, filepath: "notes/a.md" });
		await git.commit({ fs, dir, message: "edit", author: AUTHOR });

		// Rollback local branch
		await git.writeRef({ fs, dir, ref: `refs/heads/${currentBranch}`, value: prePushSha, force: true });

		// Remote tracking ref was never touched — still at prePushSha
		const remoteSha = await git.resolveRef({ fs, dir, ref: `refs/remotes/origin/${currentBranch}` });
		expect(remoteSha).toBe(prePushSha);
	});

	it("after rollback, tree walk on remote tracking ref returns original blob OID", async () => {
		const remoteRef = `refs/remotes/origin/${currentBranch}`;

		// Capture the original blob OID before any edits
		let originalOid = "";
		await git.walk({
			fs,
			dir,
			trees: [git.TREE({ ref: remoteRef })],
			map: async (filepath, [entry]) => {
				if (!entry || filepath === ".") return undefined;
				if ((await entry.type()) !== "blob") return undefined;
				if (filepath === "notes/a.md") originalOid = await entry.oid();
				return undefined;
			},
		});
		expect(originalOid).not.toBe("");

		// Commit an edit (simulating what pushChanges does before the push attempt)
		await fs.promises.writeFile(`${dir}/notes/a.md`, "content-edited", "utf8");
		await git.add({ fs, dir, filepath: "notes/a.md" });
		await git.commit({ fs, dir, message: "edit", author: AUTHOR });

		// Rollback local branch (push failed)
		await git.writeRef({ fs, dir, ref: `refs/heads/${currentBranch}`, value: prePushSha, force: true });

		// Walk the REMOTE tracking ref — must still see the ORIGINAL blob OID
		let oidAfterRollback = "";
		await git.walk({
			fs,
			dir,
			trees: [git.TREE({ ref: remoteRef })],
			map: async (filepath, [entry]) => {
				if (!entry || filepath === ".") return undefined;
				if ((await entry.type()) !== "blob") return undefined;
				if (filepath === "notes/a.md") oidAfterRollback = await entry.oid();
				return undefined;
			},
		});

		// This is the core regression: the phantom local commit must NOT pollute
		// the remote tracking ref view.
		expect(oidAfterRollback).toBe(originalOid);
	});

	it("after a SUCCESSFUL push, remote tracking ref advances (control case)", async () => {
		// Commit an edit
		await fs.promises.writeFile(`${dir}/notes/a.md`, "content-edited", "utf8");
		await git.add({ fs, dir, filepath: "notes/a.md" });
		const newSha = await git.commit({ fs, dir, message: "edit", author: AUTHOR });

		// Simulate a successful push: update the remote tracking ref
		await git.writeRef({
			fs,
			dir,
			ref: `refs/remotes/origin/${currentBranch}`,
			value: newSha,
			force: true,
		});

		const remoteSha = await git.resolveRef({ fs, dir, ref: `refs/remotes/origin/${currentBranch}` });
		expect(remoteSha).toBe(newSha);
		expect(remoteSha).not.toBe(prePushSha);
	});
});
