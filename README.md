# Obsidian GitLab Connector

Bi-directional sync between an Obsidian vault subfolder and a GitLab repository. Supports both offline-capable sync via [isomorphic-git](https://isomorphic-git.org/) and lightweight online sync via the GitLab REST API.

---

## Features

- Pull remote changes into your vault, with automatic three-way merge for non-conflicting edits
- Push local changes to GitLab with auto-generated commit messages
- **Selective commit**: choose exactly which files to include and write a custom commit message
- Two sync backends: full git (offline-capable, IndexedDB-based) or REST API (no local state, always online)
- Auto-sync on a timer or whenever vault files change
- Interactive conflict resolution for true merge conflicts
- All operations available from the ribbon menu or command palette
- **Android support**: REST API mode runs entirely in-browser with no native Node.js modules

---

## Requirements

- **Obsidian** ≥ 1.11.4 (requires SecretStorage API for PAT storage)
- **GitLab** instance (gitlab.com or self-hosted), accessible over HTTPS
- **Personal Access Token (PAT)** with `read_repository` + `write_repository` scopes

> **Note:** SSH is not supported. All communication is HTTPS only.

---

## Installation

This plugin is not yet listed in the Obsidian Community Plugins directory. Install manually:

### From a release

1. Go to the **Releases** page of this repository and download the latest release zip.
2. Extract the archive — it contains `main.js`, `manifest.json`, and `styles.css`.
3. Copy the three files into your vault's plugin folder:
   ```
   <vault>/.obsidian/plugins/obsidian-gitlab-connector/
   ```
4. Reload Obsidian (or toggle the plugin off and on in **Settings → Community Plugins**).

### From source

See [Building from Source](#building-from-source) below.

### Android

Android requires extra steps because the file manager does not let you write directly inside `.obsidian/`. Use one of these approaches:

**Option A — copy via a file manager app**

1. Build the plugin (or download a release) on a desktop machine.
2. Transfer `main.js`, `manifest.json`, and `styles.css` to your Android device (USB, cloud storage, etc.).
3. Use a file manager (e.g. *Files by Google*, *MiXplorer*) to copy the three files into:
   ```
   <internal-storage>/<vault-name>/.obsidian/plugins/obsidian-gitlab-connector/
   ```
   You may need to enable "show hidden files" to see `.obsidian/`.
4. Open Obsidian, go to **Settings → Community Plugins**, disable safe mode if prompted, and enable **GitLab Connector**.

**Option B — use Termux**

1. Install [Termux](https://termux.dev) from F-Droid (not the Play Store version — that one is outdated).
2. Grant Termux storage permission: `termux-setup-storage`
3. Copy the plugin files:
   ```sh
   VAULT="$HOME/storage/shared/YourVaultName"
   PLUGIN="$VAULT/.obsidian/plugins/obsidian-gitlab-connector"
   mkdir -p "$PLUGIN"
   cp main.js manifest.json styles.css "$PLUGIN/"
   ```
4. Restart Obsidian and enable the plugin.

> **Android sync mode:** Use **REST API** mode on Android. The isomorphic-git backend is supported but requires more memory and may be slower on low-end devices. REST API mode makes direct HTTP calls to GitLab with no local git state, which is lighter and more reliable on mobile.

---

## Building from Source

### Prerequisites

- [Node.js](https://nodejs.org/) ≥ 18
- npm ≥ 9

### Steps

```sh
# 1. Clone the repository
git clone https://github.com/<owner>/obsidian-gitlab-connector.git
cd obsidian-gitlab-connector

# 2. Install dependencies
npm install

# 3. Build a production bundle
npm run build
```

This produces `main.js` at the repository root. Copy `main.js`, `manifest.json`, and `styles.css` into your vault's plugin folder as described in [Installation](#installation).

### Development build (watch mode)

```sh
npm run dev
```

Starts esbuild in watch mode with inline source maps. Every file save triggers a rebuild. Point Obsidian's plugin folder at the repository root (or symlink it) to hot-reload during development.

### Running the test suite

```sh
npm test          # run once
npm run test:watch  # re-run on file changes
```

Tests use [Vitest](https://vitest.dev/) and run entirely in Node (no browser or Obsidian runtime needed). The suite covers path translation utilities, change detection logic, and git rollback regression tests using an in-memory filesystem.

### Project layout

```
obsidian-gitlab-connector/
├── src/
│   ├── main.ts               # Plugin entry point (Obsidian Plugin class)
│   ├── polyfills/
│   │   ├── buffer.js         # Buffer polyfill for Android/iOS WebView
│   │   └── node-crypto.js    # Pure-JS crypto polyfill for Android
│   ├── git/
│   │   └── git-manager.ts    # isomorphic-git wrapper
│   ├── sync/
│   │   ├── sync-engine.ts    # Orchestrator
│   │   ├── git-sync-backend.ts
│   │   ├── api-sync-backend.ts
│   │   ├── change-tracker.ts
│   │   ├── state-manager.ts
│   │   └── conflict-detector.ts
│   └── utils/
│       ├── path.ts           # Remote↔vault path translation
│       └── hash.ts           # SHA-256 content hashing
├── tests/
│   ├── unit/                 # Vitest unit tests + mocks + config
│   │   ├── git/git-manager.test.ts
│   │   ├── sync/change-tracker.test.ts
│   │   ├── utils/path.test.ts
│   │   ├── mocks/obsidian.ts # Minimal Obsidian stub for Node tests
│   │   └── vitest.config.mts
│   └── e2e/                  # WDIO end-to-end tests + vaults + configs
│       ├── specs/
│       ├── vaults/simple/
│       ├── wdio.conf.mts
│       ├── wdio.mobile.conf.mts
│       ├── wdio.manual-setup.conf.mts
│       └── tsconfig.json
├── scripts/                  # Developer scripts (e.g. start-emulator.sh)
├── main.js                   # Built output (committed for release)
├── manifest.json             # Obsidian plugin manifest
├── styles.css                # Plugin styles
└── esbuild.config.mjs        # Build configuration
```

---

## Configuration

Open **Settings → GitLab Connector** to configure the plugin.

| Setting | Description |
|---------|-------------|
| **GitLab URL** | Base URL of your GitLab instance, e.g. `https://gitlab.com` |
| **Project path** | Namespace and repository, e.g. `username/my-notes` |
| **Branch** | Branch to sync against, e.g. `main` |
| **Vault subfolder** | Subfolder inside your vault that maps to the remote. Leave blank to use the vault root. |
| **Remote subfolder** | Subfolder inside the GitLab repo to sync. Leave blank to use the repo root. |
| **Sync mode** | `isomorphic-git` (offline-capable, clones repo locally) or `REST API` (lightweight, always online) |
| **Sync trigger** | `Manual` (command palette / ribbon only), `File change` (push on save, debounced 5 s), or `Auto timer` |
| **Sync interval** | Minutes between automatic syncs (only used when trigger is `Auto timer`) |
| **Author name / email** | Used for git commit metadata (isomorphic-git mode only) |
| **Personal Access Token** | Your GitLab PAT — stored in OS SecretStorage, never written to `data.json` |
| **Clone depth** | Shallow clone depth for isomorphic-git mode (default: 1). Increase if you need deeper history. |

### Getting a GitLab Personal Access Token

1. Go to **GitLab → User Settings → Access Tokens** (or Profile → Preferences → Access Tokens on older versions).
2. Click **Add new token**.
3. Give it a name, set an expiry, and select the **`read_repository`** and **`write_repository`** scopes.
4. Click **Create personal access token** and copy the value into the plugin settings.

---

## Commands

All commands are available in the **command palette** (Ctrl/Cmd + P → "GitLab Connector:…") and from the **ribbon menu** (click the git icon in the left sidebar).

### Pull from remote

Fetches the latest state from GitLab and applies remote changes to your vault.

- Files added or modified on remote are written to the vault.
- Remote deletions are confirmed with a modal before applying locally.
- Files changed on both sides are passed through a three-way merge:
  - Non-overlapping edits are merged automatically.
  - True conflicts open an interactive resolution modal.

### Push to remote

Detects all locally-changed files (added, modified, deleted) and pushes them to GitLab in a single commit with an auto-generated message like `vault sync: 2 modified, 1 created`.

### Full Sync

Pull then push — equivalent to running Pull followed by Push. This is the most common operation for keeping both sides in sync.

### Commit and Push Selected Files

Opens a modal showing all locally-changed files with checkboxes. You can:

- Select or deselect individual files
- Write a custom commit message
- Confirm to push only the selected subset

This is useful when you want to commit specific changes with meaningful messages rather than pushing everything at once.

### Initialize connection

Resets the plugin state and re-runs the full initialization flow. Use this if:

- You changed the GitLab URL, project, or branch settings
- You want to reset to a clean state after an error
- You switched sync mode (isomorphic-git ↔ REST API)

On first initialization (or after a reset), a modal asks whether to **pull the remote contents** into your vault or **push your local vault contents** to GitLab.

---

## Ribbon Menu

Clicking the **git icon** in the left sidebar opens a dropdown menu with all available operations:

- **Pull** — pull remote changes
- **Push** — push local changes
- **Full Sync** — pull then push
- **Commit & Push Selected Files** — selective commit modal
- **Re-initialize** — reset and re-run setup

---

## Sync Modes

### isomorphic-git (default on desktop)

- Clones the entire repository (shallow, configurable depth) into **IndexedDB** (LightningFS) — completely invisible to Obsidian's file indexer
- Reads and writes git objects directly; no `.git` folder appears in your vault
- Supports offline commits: changes are committed locally and pushed when online
- On every pull, fetches the latest commits and fast-forwards the local branch

### REST API (recommended on Android)

- No local git state — every operation is a direct HTTP call to GitLab
- Simpler and uses less storage, but requires network access for every operation
- Uses the GitLab Commits API to push batches of changes in a single request
- Suitable for simple use cases where offline sync is not needed, and the best choice for Android

---

## Conflict Resolution

When the same file has been changed both locally and on the remote since the last sync, the plugin performs a **three-way merge** using the saved base content (the file content at last sync) as the merge ancestor.

**Auto-mergeable**: changes are in different parts of the file — merged silently.

**True conflict**: changes overlap — an interactive modal opens showing:
- The base (last-synced) content
- The local version
- The remote version
- A unified diff of each side's changes

Resolution options:
- **Keep local** — discard remote changes
- **Keep remote** — discard local changes
- **Use merged** — accept the auto-merge attempt (if available)
- **Edit manually** — close the modal and resolve the file yourself, then push again

---

## Limitations

- HTTPS only — SSH is not supported
- No delta sync — all file content is transferred on every change detection cycle
- Requires Obsidian ≥ 1.11.4 for secure PAT storage
- Binary files are not synced — only `.md` files
- isomorphic-git mode uses a shallow clone; very deep git history may not be accessible

---

## Troubleshooting

**"Failed to fetch" or network errors**
- Verify the GitLab URL is correct and reachable from your device
- Check that your PAT has not expired
- On self-hosted GitLab, ensure the instance is accessible over HTTPS

**"Push rejected — remote has new changes"**
- Run **Pull** (or **Full Sync**) first to incorporate remote changes, then push again

**"Nothing to push — no local changes detected"**
- All local files match the last-synced state; no action needed

**"Initialization failed"**
- Check that all required settings (URL, project path, branch, PAT) are filled in
- Run **Initialize connection** from the command palette or ribbon menu to retry

**Modal appears on every startup asking Pull or Push**
- This happens if the sync state was never saved (e.g. you cancelled the first-run modal)
- Select a direction and complete the first sync; the modal will not appear again

**Commit modal appears unstyled**
- Ensure `styles.css` is present alongside `main.js` in the plugin folder

**Android: "Attempting to load NodeJS package"**
- Switch to **REST API** sync mode in settings — isomorphic-git mode makes a best-effort attempt to polyfill Node built-ins, but REST API mode avoids all Node dependencies entirely
