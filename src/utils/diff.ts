/**
 * Diff and three-way merge utilities built on top of the `diff` (jsdiff) library.
 */

import { structuredPatch, createPatch, applyPatch } from "diff";
import type { StructuredPatch, StructuredPatchHunk } from "diff";
// Aliases for backward compatibility with the rest of the codebase
type ParsedDiff = StructuredPatch;
type Hunk = StructuredPatchHunk;
import type { MergeResult } from "../types";

/**
 * Generate a structured patch (list of hunks) between two strings.
 */
export function generateStructuredDiff(
	oldText: string,
	newText: string,
	filename = "file.md",
): ParsedDiff {
	return structuredPatch(filename, filename, oldText, newText, "", "", {
		context: 3,
	});
}

/**
 * Generate a unified diff string (like `diff -u`) between two texts.
 */
export function generateUnifiedDiff(
	oldText: string,
	newText: string,
	filename = "file.md",
	oldHeader = "base",
	newHeader = "modified",
): string {
	return createPatch(filename, oldText, newText, oldHeader, newHeader, {
		context: 3,
	});
}

/**
 * Attempt a three-way merge.
 *
 * Given a common `base`, a `local` version and a `remote` version,
 * try to produce a merged result.  Returns `{ success: true, merged }`
 * if the merge is clean, or `{ success: false }` if there is a conflict.
 */
export function tryThreeWayMerge(
	base: string,
	local: string,
	remote: string,
): MergeResult {
	// Trivial cases
	if (base === local) return { success: true, merged: remote };
	if (base === remote) return { success: true, merged: local };
	if (local === remote) return { success: true, merged: local };

	// Try applying local's changes on top of remote
	const patchLocal = createPatch("file", base, local, "", "", { context: 3 });
	const mergedOnRemote = applyPatch(remote, patchLocal, { fuzzFactor: 0 });
	if (mergedOnRemote !== false) {
		return { success: true, merged: mergedOnRemote };
	}

	// Try the reverse: apply remote's changes on top of local
	const patchRemote = createPatch("file", base, remote, "", "", {
		context: 3,
	});
	const mergedOnLocal = applyPatch(local, patchRemote, { fuzzFactor: 0 });
	if (mergedOnLocal !== false) {
		return { success: true, merged: mergedOnLocal };
	}

	// Both directions fail — true conflict
	return { success: false };
}

/**
 * Generate HTML for a unified diff view.
 *
 * Returns a `<div>` containing coloured lines suitable for rendering
 * inside an Obsidian modal.
 */
export function generateDiffHtml(
	oldText: string,
	newText: string,
	filename = "file.md",
): string {
	const patch = generateStructuredDiff(oldText, newText, filename);
	const lines: string[] = [];

	lines.push('<div class="glc-diff">');

	for (const hunk of patch.hunks) {
		lines.push(
			`<div class="glc-diff-hunk-header">@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@</div>`,
		);
		for (const line of hunk.lines) {
			const prefix = line.charAt(0);
			const content = escapeHtml(line.slice(1));
			if (prefix === "+") {
				lines.push(
					`<div class="glc-diff-line glc-diff-added">+ ${content}</div>`,
				);
			} else if (prefix === "-") {
				lines.push(
					`<div class="glc-diff-line glc-diff-removed">- ${content}</div>`,
				);
			} else {
				lines.push(
					`<div class="glc-diff-line glc-diff-context">  ${content}</div>`,
				);
			}
		}
	}

	lines.push("</div>");
	return lines.join("\n");
}

/**
 * Create conflict-marker text (<<<<<<< / ======= / >>>>>>>) for manual editing.
 */
export function createConflictMarkers(
	local: string,
	remote: string,
): string {
	return [
		"<<<<<<< LOCAL (Your Version)",
		local,
		"=======",
		remote,
		">>>>>>> REMOTE (GitLab)",
	].join("\n");
}

/** Count the number of change hunks in a diff. */
export function countChanges(patch: ParsedDiff): number {
	return patch.hunks.length;
}

/**
 * Render a unified diff into a container element using safe DOM APIs.
 *
 * This avoids innerHTML entirely — all text content is set via textContent,
 * which is immune to XSS regardless of what the diff content contains.
 */
export function renderDiffToContainer(
	container: HTMLElement,
	oldText: string,
	newText: string,
	filename = "file.md",
): void {
	const patch = generateStructuredDiff(oldText, newText, filename);
	const wrapper = container.createDiv({ cls: "glc-diff" });

	for (const hunk of patch.hunks) {
		const header = wrapper.createDiv({ cls: "glc-diff-hunk-header" });
		header.textContent = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;

		for (const line of hunk.lines) {
			const prefix = line.charAt(0);
			const content = line.slice(1);
			let cls = "glc-diff-line glc-diff-context";
			let marker = "  ";
			if (prefix === "+") {
				cls = "glc-diff-line glc-diff-added";
				marker = "+ ";
			} else if (prefix === "-") {
				cls = "glc-diff-line glc-diff-removed";
				marker = "- ";
			}
			const el = wrapper.createDiv({ cls });
			el.textContent = `${marker}${content}`;
		}
	}
}

/** Escape HTML special characters. */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export type { ParsedDiff, Hunk, StructuredPatch, StructuredPatchHunk };
