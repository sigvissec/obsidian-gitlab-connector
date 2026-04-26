/**
 * Manages the persistent sync state that tracks what has been
 * synchronised between the local vault and the remote repository.
 *
 * State is saved via the plugin's `saveData()` / `loadData()` mechanism
 * and lives in `data.json` under a dedicated key.
 */

import type { Plugin } from "obsidian";

/** Per-file sync state. */
export interface FileSyncState {
	/** SHA-256 hash of the file content at last successful sync. */
	contentHash: string;
	/** The actual file content at last sync (for three-way merge base). */
	baseContent: string;
	/** Remote SHA / OID for this file at last sync. */
	remoteSha: string;
	/** Timestamp of last successful sync for this file. */
	lastSynced: number;
}

/** Top-level sync state persisted to disk. */
interface SyncState {
	/** Timestamp of the last full sync operation. */
	lastSyncTimestamp: number;
	/** HEAD commit SHA on the remote at last sync. */
	lastRemoteCommitSha: string;
	/** Per-file tracking, keyed by path relative to repo root. */
	files: Record<string, FileSyncState>;
}

const EMPTY_STATE: SyncState = {
	lastSyncTimestamp: 0,
	lastRemoteCommitSha: "",
	files: {},
};

/**
 * Key under which sync state is stored inside the plugin's data.json.
 * We keep it separate from the main settings so they can evolve independently.
 */
const STATE_KEY_GIT = "syncState_git";
const STATE_KEY_API = "syncState_api";

/** Shape of the plugin's persisted data.json blob. */
type PersistedData = Record<string, unknown>;

export class StateManager {
	private plugin: Plugin;
	private stateKey: string;
	private state: SyncState;

	constructor(plugin: Plugin, mode: "git" | "api") {
		this.plugin = plugin;
		this.stateKey = mode === "git" ? STATE_KEY_GIT : STATE_KEY_API;
		this.state = { ...EMPTY_STATE, files: {} };
	}

	/** Load state from disk. Call once during plugin initialisation. */
	async load(): Promise<void> {
		const allData = (await this.plugin.loadData()) as PersistedData | null;
		const stored = allData?.[this.stateKey];
		if (stored && typeof stored === "object") {
			this.state = stored as SyncState;
			// Ensure the files object exists (defensive)
			if (!this.state.files) {
				this.state.files = {};
			}
		}
	}

	/** Persist current state to disk. */
	async save(): Promise<void> {
		const allData = ((await this.plugin.loadData()) as PersistedData | null) ?? {};
		allData[this.stateKey] = this.state;
		await this.plugin.saveData(allData);
	}

	// ── Accessors ───────────────────────────────────────────

	getState(): Readonly<SyncState> {
		return this.state;
	}

	getFileState(path: string): FileSyncState | undefined {
		return this.state.files[path];
	}

	getLastRemoteCommitSha(): string {
		return this.state.lastRemoteCommitSha;
	}

	getLastSyncTimestamp(): number {
		return this.state.lastSyncTimestamp;
	}

	getAllTrackedPaths(): string[] {
		return Object.keys(this.state.files);
	}

	// ── Mutators ────────────────────────────────────────────

	updateFileState(path: string, fileState: FileSyncState): void {
		this.state.files[path] = fileState;
	}

	removeFileState(path: string): void {
		delete this.state.files[path];
	}

	setLastRemoteCommitSha(sha: string): void {
		this.state.lastRemoteCommitSha = sha;
	}

	setLastSyncTimestamp(ts: number): void {
		this.state.lastSyncTimestamp = ts;
	}

	/** Reset all state (e.g., when switching backends or re-cloning). */
	clear(): void {
		this.state = { ...EMPTY_STATE, files: {} };
	}
}

/**
 * Wipe all persisted sync state for both backends from data.json.
 * Used during re-initialization so the first-sync modal appears again.
 */
export async function clearAllSyncState(plugin: Plugin): Promise<void> {
	const allData = ((await plugin.loadData()) as PersistedData | null) ?? {};
	delete allData[STATE_KEY_GIT];
	delete allData[STATE_KEY_API];
	await plugin.saveData(allData);
}
