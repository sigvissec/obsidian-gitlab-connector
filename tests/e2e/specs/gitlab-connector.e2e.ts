import { browser, expect } from "@wdio/globals";

// Plugin ID as declared in manifest.json
const PLUGIN_ID = "gitlab-connector";

describe("GitLab Connector Plugin", function () {
  it("is loaded and enabled", async function () {
    const isLoaded = await browser.executeObsidian(({ app }) => {
      // @ts-expect-error — plugins is typed as any in the Obsidian API stubs
      return !!app.plugins?.plugins?.["gitlab-connector"];
    });
    expect(isLoaded).toBe(true);
  });

  it("registers core commands", async function () {
    const commands = await browser.executeObsidian(({ app }) => {
      // @ts-expect-error — commands is typed as any
      return Object.keys(app.commands?.commands ?? {}).filter((id) =>
        id.startsWith("gitlab-connector:")
      );
    });
    expect(commands).toContain("gitlab-connector:pull");
    expect(commands).toContain("gitlab-connector:push");
    expect(commands).toContain("gitlab-connector:sync");
  });

  it("has a settings tab", async function () {
    const hasTab = await browser.executeObsidian(({ app }) => {
      // Plugin settings tabs live in app.setting.pluginTabs (separate from the
      // built-in settingTabs array). Check both to be safe.
      // @ts-expect-error — internal API
      const s = app.setting as any;
      const all: { id: string }[] = [
        ...(Array.isArray(s?.settingTabs) ? s.settingTabs : []),
        ...(Array.isArray(s?.pluginTabs) ? s.pluginTabs : []),
      ];
      return all.some((t) => t.id === "gitlab-connector");
    });
    expect(hasTab).toBe(true);
  });
});
