# Releasing

## Cutting a release

1. Bump `version` in `package.json` (semver; the updater compares versions).
2. Commit, then tag and push: `git tag v0.8.1 && git push origin v0.8.1`.
3. The **Release** workflow builds Windows (NSIS), macOS (universal dmg + zip) and Linux (AppImage + deb) installers and attaches them, with the update metadata (`latest.yml`, `latest-mac.yml`, `latest-linux.yml` and blockmaps), to a **draft** GitHub release.
4. Check the draft, write the notes, and publish it. Installed copies pick it up within six hours, or right away with **Check for updates**.

Local builds: `npm run dist` makes an installer for the current OS in `dist/` without publishing anything.

## How updates work

`electron-updater` reads the update metadata from the latest published GitHub release, downloads the new installer in the background (differentially where a blockmap exists), and installs it on the next restart or when the user clicks **Restart to update**. Users can turn automatic checks off in Settings → About. Builds run from source never update themselves.

Formats that can't update themselves: the Linux `.deb` (users update it with their package manager, or use the AppImage).

## Code signing

Unsigned builds work, but Windows SmartScreen shows "Windows protected your PC" and macOS refuses to open the app until the user allows it in System Settings → Privacy & Security. Signing removes both. The workflow already passes these secrets through; add them in the repository settings when they exist.

### Windows

Options, cheapest first:

- **SignPath Foundation** signs open-source projects for free with an EV-grade certificate. Apply at signpath.org with the public repository; once accepted, add their GitHub Action after the build step to sign the `.exe` and re-upload it. Their certificate is issued to SignPath Foundation, not to you.
- **Azure Trusted Signing** (about $10 a month): electron-builder supports it through `win.azureSignOptions`.
- **A code-signing certificate** from a CA: export it as a `.pfx`, base64-encode it into the `WIN_CSC_LINK` secret and put its password in `WIN_CSC_KEY_PASSWORD`.

SmartScreen reputation builds up per certificate, so warnings fade over the first releases even with a standard certificate.

### macOS

Needs an Apple Developer account ($99 a year):

- `MAC_CSC_LINK` / `MAC_CSC_KEY_PASSWORD`: a "Developer ID Application" certificate exported as `.p12`, base64-encoded.
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`: for notarization, which electron-builder runs automatically when these are present.

Without them the macOS build is unsigned; auto-update on macOS requires a signed app, so macOS users update manually until then.

### Linux

No signing needed. AppImage users get in-app updates.

## Before the first public release

- The app id (`io.github.aashifahd.devplus` in `electron-builder.yml`) must never change after the first public release: installed copies use it to find their updates.
- Create the `devplus` repository on GitHub (or update `publish` in `electron-builder.yml` and `REPO_URL` in `src/shared/app.ts`).
- Turn on private vulnerability reporting (Settings → Code security) so `SECURITY.md` works.
