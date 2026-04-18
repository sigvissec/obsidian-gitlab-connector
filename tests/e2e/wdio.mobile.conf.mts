import * as path from "path";
import { execSync } from "child_process";
import { parseObsidianVersions } from "wdio-obsidian-service";
import { env } from "process";

// Android E2E testing via the real Obsidian Android app.
// Prerequisites:
//   1. Set ANDROID_HOME=~/Android/Sdk in your shell
//   2. Have the "Pixel_10" AVD available in Android Studio
//   See: https://jesse-r-s-hines.github.io/wdio-obsidian-service/wdio-obsidian-service/README#android

const cacheDir = path.resolve(".obsidian-cache");

// Beta versions are not available for the Android app
const defaultVersions = "latest/latest";
const versions = await parseObsidianVersions(
  env.OBSIDIAN_MOBILE_VERSIONS ?? env.OBSIDIAN_VERSIONS ?? defaultVersions,
  { cacheDir },
);

export const config: WebdriverIO.Config = {
  runner: "local",
  framework: "mocha",

  specs: ["./specs/**/*.e2e.ts"],

  maxInstances: 1, // Parallel tests don't work under Appium
  hostname: env.APPIUM_HOST || "localhost",
  port: parseInt(env.APPIUM_PORT || "4723"),
  // Give the emulator plenty of time to cold-boot before WDIO aborts the session request
  connectionRetryTimeout: 600 * 1000,
  connectionRetryCount: 0,

  capabilities: versions.map<WebdriverIO.Capabilities>(([appVersion]) => ({
    browserName: "obsidian",
    browserVersion: appVersion,
    platformName: "Android",
    "appium:automationName": "UiAutomator2",
    "appium:avd": "Pixel_10",
    // noReset speeds up tests; wdio-obsidian-service handles Obsidian resets
    "appium:noReset": true,
    "appium:avdLaunchTimeout": 300 * 1000,
    "appium:avdReadyTimeout": 300 * 1000,
    "appium:adbExecTimeout": 120 * 1000,
    // Obsidian's MainActivity can take >20s (Appium default) on the first
    // cold launch after an emulator boot because the runtime still runs
    // dex2oat / verifies classes. 4 minutes is a safe ceiling on slow hosts.
    "appium:appWaitDuration": 240 * 1000,
    "appium:androidInstallTimeout": 300 * 1000,
    "wdio:obsidianOptions": {
      plugins: ["../.."],
      vault: "vaults/simple",
    },
  })),

  onPrepare() {
    // Ensure the ADB server is running before Appium tries to connect to the AVD.
    // A stale or missing ADB server causes "Error getting AVD with retry" timeouts.
    try { execSync("adb start-server", { stdio: "inherit" }); } catch { /* ignore */ }
  },

  services: [
    "obsidian",
    ["appium", {
      args: { allowInsecure: "*:chromedriver_autodownload,*:adb_shell" },
    }],
  ],
  reporters: ["obsidian"],

  mochaOpts: {
    ui: "bdd",
    timeout: 120 * 1000,
  },
  waitforInterval: 250,
  waitforTimeout: 10 * 1000,
  logLevel: "warn",

  cacheDir,
  injectGlobals: false,
};
