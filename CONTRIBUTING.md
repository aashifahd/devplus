# Contributing

Thanks for helping. A few things make reviews quick.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- Search existing issues; someone may already be on it.

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

- One topic per pull request, with a description of what changed and how you tested it (screenshots for UI changes help).
- Mention which database engines you tried it against.

## License of contributions

By contributing, you agree that your contribution is licensed under the project's license, [GPL-3.0-or-later](LICENSE).
