# Releasing

## Cutting a release

1. Open a pull request titled `chore: release 0.8.1` that bumps `version` in `package.json` (semver; the updater compares versions), and merge it.
2. On an up-to-date `main` (or `release/x.y` for a patch to an older version), run `npm run release:tag`. It checks the branch and version, then pushes the `v0.8.1` tag. Only the maintainer can push `v*` tags.
3. The **Release** workflow builds Windows (NSIS), macOS (Apple Silicon dmg + zip) and Linux (AppImage + deb) installers and attaches them, with the update metadata (`latest.yml`, `latest-mac.yml`, `latest-linux.yml` and blockmaps), to a **draft** GitHub release.
4. Check the draft. Its notes are generated from the merged pull requests, grouped by label (see `.github/release.yml`); edit them if needed, then publish it. Installed copies pick it up within six hours, or right away with **Check for updates**.

Local builds: `npm run dist` makes an installer for the current OS in `dist/` without publishing anything.

## Updating the local server catalog

The server versions DevPlus can install, with their download URLs and SHA-256 checksums, live in `src/shared/serverCatalog.ts`. To pick up new releases, edit the version lists at the top of `scripts/server-catalog.mjs` and run:

```bash
node scripts/server-catalog.mjs
```

It reads MariaDB's published checksums and downloads the PostgreSQL and MySQL archives once (about 2 GB, cached in `.server-cache/`) to hash them. Commit the regenerated file in a pull request.

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

Without them the workflow ad-hoc signs the macOS build (Apple Silicon refuses fully unsigned apps). It opens after the user allows it once in System Settings → Privacy & Security, but auto-update on macOS needs a Developer ID signature, so macOS users update manually until then.

### Linux

No signing needed. AppImage users get in-app updates.

## Before the first public release

- The app id (`io.github.aashifahd.devplus` in `electron-builder.yml`) must never change after the first public release: installed copies use it to find their updates.
- Create the `devplus` repository on GitHub (or update `publish` in `electron-builder.yml` and `REPO_URL` in `src/shared/app.ts`).
- Turn on private vulnerability reporting (Settings → Code security) so `SECURITY.md` works.
