# Security policy

DevPlus holds database credentials and runs queries against production systems, so security reports get priority.

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub's private reporting instead: the repository's **Security** tab → **Report a vulnerability**.

Include what you found, how to reproduce it, and the version you tested (Settings → About). You will get an acknowledgement within a few days, and a fix or a plan before anything is disclosed.

## Scope

Especially interesting:

- Credentials, AI keys or query data leaving the machine, or being stored unencrypted
- A plugin escaping its sandbox, or running queries that safe mode should block
- Safe mode or read-only connections being bypassed
- Code execution through a crafted database, file import, or connection import
- Problems in the update mechanism

Supported versions: the latest release.
