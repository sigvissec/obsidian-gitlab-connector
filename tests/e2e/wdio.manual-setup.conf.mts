/**
 * WDIO config used by scripts/start-emulator.sh to install the plugin into
 * Obsidian on the running emulator and leave it open for manual testing.
 *
 * Not intended for CI — use wdio.mobile.conf.mts for automated tests.
 *
 * Both `specs` and `wdio:obsidianOptions.vault` are resolved relative to
 * this config file's directory. `cacheDir` (declared below with
 * `path.resolve`) is deliberately anchored to the project root so cache
 * hits carry across test configs.
 */
import * as path from "path";
import { execSync } from "child_process";
import { parseObsidianVersions } from "wdio-obsidian-service";
import { env } from "process";

const cacheDir = path.resolve(".obsidian-cache");

const versions = await parseObsidianVersions("latest/latest", { cacheDir });

export const config: WebdriverIO.Config = {
  runner: "local",
  framework: "mocha",

  specs: ["./specs/manual-setup.ts"],

  maxInstances: 1,
  hostname: env.APPIUM_HOST || "localhost",
  port: parseInt(env.APPIUM_PORT || "4723"),

  // Give the already-running emulator plenty of time to respond.
  connectionRetryTimeout: 600 * 1000,
  connectionRetryCount: 0,

  capabilities: versions.map<WebdriverIO.Capabilities>(([appVersion]) => ({
    browserName: "obsidian",
    browserVersion: appVersion,
    platformName: "Android",
    "appium:automationName": "UiAutomator2",
    "appium:avd": "Pixel_10",
    "appium:noReset": true,
    "appium:avdLaunchTimeout": 300 * 1000,
    "appium:avdReadyTimeout": 300 * 1000,
    "appium:adbExecTimeout": 120 * 1000,
    // Obsidian's MainActivity can take >20s (Appium default) on the first
    // cold launch after an emulator boot because the runtime still runs
    // dex2oat / verifies classes. Give it up to 2 minutes.
    "appium:appWaitDuration": 120 * 1000,
    "appium:androidInstallTimeout": 300 * 1000,
    "wdio:obsidianOptions": {
      plugins: ["../.."],
      vault: "vaults/simple",
      // copy: false keeps the vault on the device after teardown so Obsidian
      // can continue using it for manual testing once WDIO exits.
      copy: false,
    },
  })),

  services: [
    "obsidian",
    ["appium", {
      args: { allowInsecure: "*:chromedriver_autodownload,*:adb_shell" },
    }],
  ],
  reporters: ["spec"],

  mochaOpts: {
    ui: "bdd",
    timeout: 120 * 1000,
  },
  waitforInterval: 250,
  waitforTimeout: 10 * 1000,
  logLevel: "warn",

  onPrepare() {
    try { execSync("adb start-server", { stdio: "inherit" }); } catch { /* ignore */ }
  },

  cacheDir,
  injectGlobals: false,
};
