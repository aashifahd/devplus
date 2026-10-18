# Features in detail

What each part of DevPlus does, and its known limits.

## Core: connections, engines, grid
- Connection manager: groups, colors, env tags (production gets a red bar), duplicate/edit/delete, search
- PostgreSQL, MySQL/MariaDB, SQLite (built-in `node:sqlite`, so no native build step)
- SSL modes (disable / prefer / require / verify-full with CA file)
- SSH tunnels: password, private key (+ passphrase), or SSH agent (Windows OpenSSH pipe)
- Passwords encrypted with the OS keychain (Electron safeStorage / DPAPI), never written as plain text
- Schema tree with filter, database switcher
- Table tabs with a canvas grid (Glide): sort by header click, filter bar (13 operators), paging, row counts, generated SQL in the footer

## Editing and safe mode
- Inline cell editing (type to edit, Enter to save to pending); NULL, empty string, DEFAULT and revert from the right-click menu
- Add row (Ctrl+I), duplicate row, delete rows (select row markers, then Del); deleted rows can be restored before commit
- Pending changes are tinted (amber edited, green new, red deleted) and counted in the footer; Discard, Preview SQL, Commit (Ctrl+S)
- Every commit runs in one transaction. Each update or delete must hit exactly one row, or the whole commit rolls back
- Tables without a primary key are still editable: the first row whose text matches is targeted (ctid on Postgres, rowid on SQLite, LIMIT 1 on MySQL)
- Safe mode per connection: Off / Confirm (always review SQL; production defaults to this) / Read-only (also enforced in the main process)
- Leaving a page, sort, filter, tab, database or connection with unsaved edits asks first

## Query editor
- SQL query tabs (Ctrl+T or the SQL button) using Monaco, light/dark themed
- Ctrl+Enter runs the selection or the statement at the cursor; Ctrl+Shift+Enter runs everything. Statements run one by one (autocommit), each in its own result tab; the run stops at the first error
- Statement splitting respects strings, comments, backticks and Postgres dollar quoting (`src/shared/sqlsplit.ts`)
- Errors open an Error tab; Postgres errors also get a squiggle at the exact position
- Schema autocomplete: tables, plus columns of the tables in the statement, with `alias.` and `schema.` resolution, keywords and functions
- Format (Shift+Alt+F or the button) via sql-formatter, using the dialect for each engine
- Explain (Ctrl+E): EXPLAIN on Postgres/MySQL, EXPLAIN QUERY PLAN on SQLite
- Cancel for Postgres (pg_cancel_backend) and MySQL (KILL QUERY); SQLite runs synchronously and can't be cancelled
- History per connection (last 500) and saved queries (Ctrl+S), both in a side panel
- Safe mode applies here too: Confirm asks before any data-changing statement; Read-only blocks them up front and also runs inside a server read-only transaction (`query_only` on SQLite)
- Result sets are capped at 50,000 rows, with a notice when that happens

## Structure and DDL
- Data / Structure toggle on every table tab. Structure shows columns, indexes, foreign keys, triggers and the DDL (copy it or open it in the SQL editor)
- Table designer: add, rename, retype and drop columns; change null/default/comment; add and drop indexes and foreign keys; rename the table. Changes are tinted, previewed as SQL, then applied in one transaction where the engine allows
- New table (the + in the sidebar, or right-click a schema) uses the same designer, with primary key, auto-increment, foreign keys and indexes
- DDL is built per engine (`src/main/drivers/ddl.ts`) and always ordered safely (drop FKs, then indexes, then columns, then alters, adds, new indexes, new FKs, rename)
- SQLite limits are explained in the UI rather than failing: it can add, rename or drop columns in place, but type/null/default/FK changes need a table rebuild (planned later)
- Functions and procedures appear in the sidebar; click one to open its definition in a SQL tab
- Right-click a table or view: open data or structure, select top 100, copy name, truncate, drop (all previewed first)
- Users/roles screen (list, create with a masked password in the preview, drop) and a process list (2 s auto-refresh, hide idle, cancel query, kill). Postgres and MySQL only
- Read-only connections block every DDL and admin action in the main process too
- The statement splitter keeps `BEGIN … END` bodies of triggers and routines intact

## Import, export, backup
- Export a table (all rows or just the filtered ones) or a query result to CSV, TSV, JSON or SQL INSERT. Tables stream to disk 5,000 rows at a time with progress. SQL can include CREATE TABLE; binary values become proper literals (`'\x…'` / `X'…'`)
- Import CSV/TSV/JSON into a table: delimiter auto-detection, header toggle, columns matched by name (editable mapping), empty-as-NULL, optional "delete existing rows first". One transaction: any bad row imports nothing, and the error names the row range
- Right-click rows in the grid or a query result to copy them as TSV, CSV, JSON or INSERT statements
- Backup: pg_dump (plain or custom archive) and mysqldump, with structure/data choices, table selection, clean/no-owner, routines and single-transaction. Tools are auto-detected (PATH and the usual install folders) or located manually. Output streams to a live log. SQLite uses VACUUM INTO
- Restore: psql for .sql, pg_restore for archives, the mysql client for MySQL; or run a plain .sql file in the app (works for SQLite too). Always confirmed; blocked on read-only connections
- External tools connect through the SSH tunnel when there is one. Passwords never go on the command line (PGPASSWORD for Postgres, a temporary 0600 option file for MySQL that is deleted afterwards)
- `DBC_TEST_DIALOGS` (test-only) lets automated UI tests answer file dialogs

## More engines
Each engine declares its connection fields and capabilities in `src/shared/engines.ts`; the UI shows only what an engine supports.

| Engine | Driver | Grid editing | Structure / designer | Notes |
|---|---|---|---|---|
| SQL Server | `mssql` | yes (TOP (1) without a PK) | yes / yes | GO batches, multiple result sets, SHOWPLAN explain, users, sessions + KILL |
| DuckDB | `@duckdb/node-api` | yes (rowid) | yes / yes | file or :memory:, interrupt-based cancel |
| ClickHouse | `@clickhouse/client` | read-only (mutations are async) | yes / – | readonly=2 for read-only connections, KILL QUERY cancel, users, processes |
| Snowflake | `snowflake-sdk` | yes (one-row check) | yes / – | account/warehouse/role; **only the error path was tested (no account)** |
| BigQuery | `@google-cloud/bigquery` | read-only | yes / – | service-account key or ADC; dry-run "explain" shows bytes scanned; tested on the goccy emulator |
| MongoDB | `mongodb` | yes (by _id; transaction on replica sets) | inferred / – | shell editor: db.x.find/aggregate/…, ObjectId/ISODate/regex literals, killOp cancel |
| Redis | `ioredis` | yes (per type: SET, HSET, LSET, SADD, ZADD…; MULTI/EXEC) | – | key browser with pattern filter, per-type key views, raw command editor, CLIENT LIST/KILL |
| Cassandra / ScyllaDB | `cassandra-driver` | yes (typed values, logged batch; UPDATE is an upsert) | yes / – | CQL editor incl. batches; no server-side OFFSET/ORDER so pages are read through and sorted locally |
| DynamoDB | `@aws-sdk/client-dynamodb` | yes (TransactWriteItems with existence conditions) | yes / – | PartiQL editor; Scan paging; local endpoint or AWS |

Known limits: filters are off for Cassandra and DynamoDB (use the query editor), Redis lists at most N keys in the tree (setting per connection), SQL Server can only KILL whole sessions.

## AI, dashboards, maps, diagrams, plugins, themes
- **AI assistant** (Ctrl+L in the SQL editor, or the sparkle button): text to SQL, explain the query at the cursor, fix the last error. Bring your own key: Anthropic (official SDK, default `claude-opus-5-5`, streaming, adaptive thinking at medium effort, server-side refusal fallback on models that support it), OpenAI, or any OpenAI-compatible server (Ollama, LM Studio, vLLM; key optional). Keys are encrypted with the OS keychain (`ai-keys.json`). The schema (table and column names and types, most relevant tables first, capped at ~160 KB) is sent as a cached system block; sample rows only if you turn that on. Replies are inserted for you to review and never run on their own. "Test connection" checks key and model without spending tokens
- **Metrics boards**: number, line, bar and table widgets from a saved query or inline SQL, on a three-column grid, with auto-refresh while the board is open. Widgets run read-only and stay out of the query history. Boards live in `metrics.json` per connection. Charts are hand-drawn SVG with a validated colorblind-safe palette (light and dark steps), hover tooltips, and a table view on every chart
- **Map view**: a Map button appears on table pages and query results that hold locations: lat/lng column pairs, GeoJSON, WKT/EWKT, PostGIS EWKB hex, MySQL geometry binary. SRID 4326/4269 shown as is, 3857 reprojected, other systems skipped. Leaflet with OpenStreetMap tiles (attribution shown, dimmed in dark mode); click a point for its row
- **ER diagram** per schema (header button or palette): layered layout with parents left of children, drag tables (positions remembered), pan and zoom, find table or column, hover to highlight relations, double-click to open, export SVG with colors baked in
- **Plugins**: `.js` files in `%APPDATA%\DevPlus\plugins`, each in its own sandboxed Web Worker with no Node, file or network access. The `devplus` API registers palette commands, cell formatters (display only; raw values stay for copy and edit) and exporters, and can read context, insert text and run queries (writes are blocked on read-only connections and confirmed on guarded ones). Calls time out after 10 s. Settings → Plugins adds a commented example
- **Settings** (Ctrl+,): light/dark/system theme, accent color, editor and grid font size, row density; every shortcut is rebindable with clash warnings; command palette (Ctrl+Shift+P)

Known limits: map tiles come from the public OpenStreetMap servers (fine for occasional use; heavy use should point at your own tile server); SQL Server geography binary isn't decoded (use `.STAsText()`); the ER diagram reads at most 300 tables per schema.
