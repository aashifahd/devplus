# Branching and releases

DevPlus uses **GitHub Flow with release branches**: one always-releasable `main`, short-lived topic branches for every change, and a `release/x.y` branch only when an older version needs a patch.

```
feature/ai-history ──┐
fix/grid-paste ──────┼──► main ──► tag v0.9.0
docs/readme ─────────┘      │
                            └──► release/0.8 ──► tag v0.8.1  (hotfix, cherry-picked from main)
```

## Branches

| Branch | Purpose | Lifetime |
|---|---|---|
| `main` | Always builds and passes CI; every release is tagged from here | Permanent, protected |
| `feature/…` or `feat/…` | New functionality | Until merged |
| `fix/…` | Bug fixes | Until merged |
| `perf/…`, `refactor/…`, `test/…` | Performance, restructuring, tests | Until merged |
| `docs/…`, `ci/…`, `chore/…` | Documentation, workflows, maintenance | Until merged |
| `release/x.y` | Patch releases for an already shipped minor version | Kept while that version is supported |
| `dependabot/…` | Created by Dependabot | Until merged |

Branch names use lower-case words separated by hyphens: `fix/grid-paste-crlf`, `feature/oracle-adapter`. Other names are rejected when you push.

`main` and `release/*` are protected: changes arrive only through pull requests, with passing CI on Windows, macOS and Linux and the maintainer's approval. No one can force-push to or delete them.

## Day-to-day flow

1. Update `main` and branch from it:
   ```bash
   git switch main
   git pull
   git switch -c fix/grid-paste-crlf
   ```
2. Commit as often as you like; the commits are squashed on merge.
3. Push and open a pull request against `main`:
   ```bash
   git push -u origin fix/grid-paste-crlf
   gh pr create --fill
   ```
4. Give the pull request a **conventional title**, because it becomes the commit message on `main` and the line in the release notes:

   | Title starts with | Meaning | Release notes section |
   |---|---|---|
   | `feat:` | New feature | New features |
   | `fix:` | Bug fix | Bug fixes |
   | `perf:` | Faster, lighter | Performance |
   | `refactor:` `test:` | No behavior change | Maintenance |
   | `docs:` | Documentation | Documentation |
   | `ci:` `build:` `chore:` `deps:` | Tooling and dependencies | Maintenance |
   | `revert:` | Undo an earlier change | Bug fixes |

   An optional scope names the area, and `!` marks a breaking change: `fix(grid): keep CRLF when pasting`, `feat(ai)!: drop the legacy provider setting`. A check rejects titles that don't follow this, and a label is added automatically from the type.
5. When CI is green and the change is approved, **squash and merge**. The branch is deleted automatically.

Keep branches small and short-lived. Rebase on `main` (`git pull --rebase origin main`) if `main` moves on before you merge; `main` requires the branch to be up to date.

## Releasing

1. Open a pull request titled `chore: release 0.9.0` that bumps `version` in `package.json` (`npm version 0.9.0 --no-git-tag-version`).
2. Merge it, then tag `main` from an up-to-date checkout:
   ```bash
   git switch main
   git pull
   npm run release:tag
   ```
   The script checks that you are on a clean, up-to-date `main` or `release/*` branch and that the tag matches `package.json`, then pushes `v0.9.0`.
3. The Release workflow builds every installer into a draft release with notes grouped by the pull request labels. Review the draft and publish it.

Only the maintainer can push `v*` tags.

## Patching an older version

When `main` already contains unreleased work and 0.8 needs a fix:

1. Create the release branch from the last tag, once per minor version:
   ```bash
   git switch -c release/0.8 v0.8.0
   git push -u origin release/0.8
   ```
2. Fix the bug on `main` first, through a normal pull request.
3. Backport it with a pull request against `release/0.8`:
   ```bash
   git switch -c fix/0.8-grid-paste release/0.8
   git cherry-pick <commit-on-main>
   git push -u origin fix/0.8-grid-paste
   gh pr create --base release/0.8 --fill
   ```
4. In another pull request against `release/0.8`, bump the version to `0.8.1`, merge it, then run `npm run release:tag` on `release/0.8`.

Fixes always land on `main` first, so a later release never loses them.

## Dependencies

Dependabot opens grouped update pull requests every Monday for npm packages and GitHub Actions, and security fixes as soon as they're available. Treat them like any other pull request: let CI run, skim the changelog for major updates, squash and merge.
