/**
 * "Spec" used only by the manual-launch script.
 * No assertions — the whole point is just to let wdio-obsidian-service open
 * the vault and install the plugin, then exit so Obsidian stays running.
 *
 * The wdio-obsidian-service `after` hook clears localStorage as cleanup.
 * We override `localStorage.clear` here so it immediately re-sets the vault
 * configuration after clearing.  Combined with `copy: false` in the config
 * (which prevents the on-device vault directory from being deleted), this
 * leaves Obsidian in a fully configured state after WDIO exits.
 */
import { browser } from "@wdio/globals";

describe("Manual setup", function () {
  it("vault and plugin are ready", async function () {
    // Capture the vault path the service just configured.
    const vaultPath = await browser.execute(
      () => localStorage.getItem("mobile-selected-vault") ?? "",
    );
    const vaultList = await browser.execute(
      () => localStorage.getItem("mobile-external-vaults") ?? "",
    );

    if (!vaultPath) return; // nothing to preserve

    // Override localStorage.clear so that when the service teardown calls it,
    // the vault registration is restored immediately.  The subsequent
    // location.reload() inside appiumCloseVault then restarts Obsidian with
    // the vault still configured.
    await browser.execute(
      (path, list) => {
        localStorage.clear = function () {
          Object.getPrototypeOf(localStorage).clear.call(localStorage);
          localStorage.setItem("mobile-external-vaults", list);
          localStorage.setItem("mobile-selected-vault", path);
          localStorage.setItem("enable-plugin-" + path, "true");
        };
      },
      vaultPath,
      vaultList,
    );
  });
});
