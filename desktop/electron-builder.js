// electron-builder's settings. The app's name and app id are src/edition.js
// PRODUCT; its data folder (userData) is named after package.json's name.
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PRODUCT, updateFeed } from "./src/edition.js";

export function builderConfig() {
  const { name, appId } = PRODUCT;
  return {
    appId,
    productName: name,
    copyright: "Copyright © 2026 ESTsoft corp.",
    directories: { output: "dist" },
    // The tests beside the code stay out of app.asar (2026-10-28, 1.0.0's had 47).
    files: ["main.js", "preload.cjs", "src/**", "!src/**/*.test.mjs", "screens/**", "i18n/**", "fake/**", "config.json"],
    extraResources: [
      { from: "resources/payload", to: "payload" },
      { from: "../LICENSE", to: "LICENSE" },
      { from: "../NOTICE", to: "NOTICE" },
    ],
    mac: {
      hardenedRuntime: true,
      entitlements: "entitlements.mac.plist",
      entitlementsInherit: "entitlements.mac.plist",
      notarize: true,
    },
    win: {
      target: [{ target: "nsis", arch: ["x64"] }],
      artifactName: "${productName}-Setup-${version}.${ext}",
      // The auto-updater installs a downloaded installer only when its
      // Authenticode signature names this publisher (the company's
      // certificate, applied after the build); without the name it checked
      // nothing beyond latest.yml's hash. electron-builder 26 reads the name
      // from signtoolOptions, and signs nothing while no certificate is set.
      signtoolOptions: { publisherName: ["ESTsoft Corp."] },
    },
    nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true },
    // Where latest.yml and app-update.yml say the updates are: the public
    // releases.
    publish: [updateFeed()],
    // The dmg again as <name>-mac.dmg, the name with no version in it that a
    // download button links to.
    afterAllArtifactBuild: ({ artifactPaths }) => artifactPaths.filter((p) => p.endsWith("-arm64.dmg")).map((p) => {
      const to = join(dirname(p), `${name}-mac.dmg`);
      copyFileSync(p, to);
      return to;
    }),
  };
}

export default builderConfig();
