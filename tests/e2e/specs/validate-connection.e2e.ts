/**
 * Live "Validate connection" test against a real GitLab repository.
 *
 * Requires:
 *   - A PAT pre-populated in Obsidian's secretStorage under "gitlab-connector-pat"
 *     (the user sets this once on the emulator; noReset:true preserves it).
 *   - The test project path below to be accessible with that PAT.
 *
 * If no PAT is found on the device, the suite is skipped rather than failing —
 * the E2E tests must stay runnable on a fresh CI emulator with no credentials.
 */
import { browser, expect } from "@wdio/globals";
import type { ConnectionCheckResult } from "../../../src/types";

const PLUGIN_ID = "gitlab-connector";
const TEST_PROJECT_PATH = "sigvis/testwoot";
const TEST_GITLAB_URL = "https://gitlab.com";
const BOGUS_BRANCH = "zz-does-not-exist-zz-9999";

interface PluginHandle {
  settings: {
    gitlabUrl: string;
    projectPath: string;
    branch: string;
  };
  saveSettings: () => Promise<void>;
  checkConnection: () => Promise<ConnectionCheckResult>;
}

describe("Validate connection (live, testwoot)", function () {
  // Network round-trips + two checkConnection() calls + restore; keep generous.
  this.timeout(60_000);

  let originalSettings: PluginHandle["settings"] | null = null;
  let hasPat = false;
  let realBranch = "";

  before(async function () {
    hasPat = await browser.executeObsidian(({ app }) => {
      return !!(app.secretStorage.getSecret("gitlab-connector-pat"));
    });
    if (!hasPat) {
      // eslint-disable-next-line no-console
      console.warn("[validate-connection.e2e] No PAT in secretStorage — skipping live tests");
      this.skip();
      return;
    }

    // Save the user's current settings so we can restore them.
    originalSettings = await browser.executeObsidian(({ app }, pluginId) => {
      // @ts-expect-error — plugins is untyped
      const p = app.plugins?.plugins?.[pluginId] as PluginHandle | undefined;
      if (!p) return null;
      const { gitlabUrl, projectPath, branch } = p.settings;
      return { gitlabUrl, projectPath, branch };
    }, PLUGIN_ID);
    expect(originalSettings).not.toBeNull();

    // Discover testwoot's actual default branch via the GitLab API so this
    // spec doesn't hard-code assumptions about whether it's "main" or "master".
    realBranch = await browser.executeObsidian(async ({ app }, projectPath, gitlabUrl) => {
      const pat = app.secretStorage.getSecret("gitlab-connector-pat") ?? "";
      const url = `${gitlabUrl}/api/v4/projects/${encodeURIComponent(projectPath)}/repository/branches?per_page=1`;
      const r = await fetch(url, { headers: { "PRIVATE-TOKEN": pat } });
      if (!r.ok) return "";
      const body = (await r.json()) as Array<{ name: string }>;
      return Array.isArray(body) && body.length > 0 ? body[0].name : "";
    }, TEST_PROJECT_PATH, TEST_GITLAB_URL);
    expect(realBranch).not.toBe("");
  });

  after(async function () {
    if (!originalSettings) return;
    await browser.executeObsidian(async ({ app }, pluginId, settings) => {
      // @ts-expect-error — plugins is untyped
      const p = app.plugins?.plugins?.[pluginId] as PluginHandle | undefined;
      if (!p) return;
      p.settings.gitlabUrl = settings.gitlabUrl;
      p.settings.projectPath = settings.projectPath;
      p.settings.branch = settings.branch;
      await p.saveSettings();
    }, PLUGIN_ID, originalSettings);
  });

  it("returns 'ok' for a valid repo and existing branch", async function () {
    const result = await browser.executeObsidian(
      async ({ app }, pluginId, gitlabUrl, projectPath, branch) => {
        // @ts-expect-error — plugins is untyped
        const p = app.plugins?.plugins?.[pluginId] as PluginHandle | undefined;
        if (!p) return null;
        p.settings.gitlabUrl = gitlabUrl;
        p.settings.projectPath = projectPath;
        p.settings.branch = branch;
        await p.saveSettings();
        return await p.checkConnection();
      },
      PLUGIN_ID, TEST_GITLAB_URL, TEST_PROJECT_PATH, realBranch,
    );
    expect(result).toEqual({ kind: "ok" });
  });

  it("returns 'branch-missing' when repo is valid but branch does not exist", async function () {
    const result = await browser.executeObsidian(
      async ({ app }, pluginId, gitlabUrl, projectPath, branch) => {
        // @ts-expect-error — plugins is untyped
        const p = app.plugins?.plugins?.[pluginId] as PluginHandle | undefined;
        if (!p) return null;
        p.settings.gitlabUrl = gitlabUrl;
        p.settings.projectPath = projectPath;
        p.settings.branch = branch;
        await p.saveSettings();
        return await p.checkConnection();
      },
      PLUGIN_ID, TEST_GITLAB_URL, TEST_PROJECT_PATH, BOGUS_BRANCH,
    );
    expect(result).toEqual({ kind: "branch-missing", branch: BOGUS_BRANCH });
  });
});
