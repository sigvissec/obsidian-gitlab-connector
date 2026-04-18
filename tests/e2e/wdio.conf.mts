import * as path from "path";
import { parseObsidianVersions } from "wdio-obsidian-service";
import { env } from "process";

// Desktop E2E testing via the Obsidian desktop app.
// Run with: npm run test:e2e

const cacheDir = path.resolve(".obsidian-cache");
const defaultVersions = "latest/latest";

const versions = await parseObsidianVersions(
  env.OBSIDIAN_VERSIONS ?? defaultVersions,
  { cacheDir },
);

export const config: WebdriverIO.Config = {
  runner: "local",
  framework: "mocha",

  specs: ["./specs/**/*.e2e.ts"],

  maxInstances: 1,
  capabilities: versions.map<WebdriverIO.Capabilities>(([appVersion, installerVersion]) => ({
    browserName: "obsidian",
    "wdio:obsidianOptions": {
      appVersion,
      installerVersion,
      plugins: ["../.."],
      vault: "vaults/simple",
    },
  })),

  services: ["obsidian"],
  reporters: ["obsidian"],

  mochaOpts: {
    ui: "bdd",
    timeout: 60 * 1000,
  },
  waitforInterval: 250,
  waitforTimeout: 5 * 1000,
  logLevel: "warn",

  cacheDir,
  injectGlobals: false,
};
