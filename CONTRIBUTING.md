# Contributing

Thanks for helping. A few things make reviews quick.

## How contributions work

- **Anyone** can open issues: bug reports, ideas and questions are all welcome. Search existing issues first; someone may already be on it.
- **Pull requests are open to collaborators only.** If you'd like to contribute code, open an issue describing what you want to change. Once we agree on the approach, the maintainer can add you as a collaborator so you can open a pull request.
- Every pull request needs the maintainer's approval and passing CI on Windows, macOS and Linux before it is merged. `main` is protected: no direct pushes, force pushes or deletion.

## Setup

```bash
npm install
npm run dev
```

The app talks to real databases, so most work needs one running locally. Docker is the easiest way, for example:

```bash
docker run -d --name dbc-pg -e POSTGRES_PASSWORD=secret -p 55432:5432 postgres:17
```

## Making a change

- `npm run typecheck` and `npm run build` must pass.
- Keep the style of the surrounding code: TypeScript, React function components, Tailwind utility classes, comments only where the code can't say it.
- Engine-specific behaviour belongs in that engine's driver and its entry in `src/shared/engines.ts`. The UI reads capabilities from there instead of checking engine names.
- Everything that writes to a database must respect the connection's safe mode, in the main process as well as the UI.
- Never log or send passwords, keys or query results anywhere.
- If you add a dependency, run `npm run notices` to check its license is compatible with GPL-3.0.
- UI text is short and plain, in sentence case.

## Pull requests

- Follow [docs/BRANCHING.md](docs/BRANCHING.md): branch from `main` with a prefixed name (`feature/…`, `fix/…`, `docs/…`), and open the pull request against `main`. Merges are squash or rebase only, so history stays linear.
- Use a [Conventional Commits](https://www.conventionalcommits.org) title such as `fix(grid): keep CRLF when pasting`. It becomes the commit on `main` and the line in the release notes, and a check enforces it.
- One topic per pull request, with a description of what changed and how you tested it (screenshots for UI changes help).
- Mention which database engines you tried it against.

## License of contributions

By contributing, you agree that your contribution is licensed under the project's license, [GPL-3.0-or-later](LICENSE).
