# Roadmap

## Done

1. **Core**: connection manager with groups, colors and environment tags; PostgreSQL, MySQL/MariaDB, SQLite; SSH tunnels and SSL; schema tree; virtualized grid with paging, sort and filters
2. **Editing**: inline edits, add and delete rows, staged changes with SQL preview and one-transaction commit, safe mode
3. **Query editor**: Monaco tabs, run current, selected or all, multiple result sets, autocomplete, formatter, history, saved queries, cancel, explain
4. **Structure and DDL**: structure view, table designer that writes the DDL, views and functions, users and roles, process list
5. **Import, export, backup**: CSV/TSV/JSON/SQL, pg_dump and mysqldump backup and restore, copy rows as INSERT, CSV or JSON
6. **More engines**: SQL Server, DuckDB, ClickHouse, Snowflake, BigQuery, MongoDB, Redis, Cassandra/ScyllaDB, DynamoDB
7. **Extras**: AI assistant with your own key, metrics boards, map view, ER diagram, plugin API, themes and keybindings
8. **Ship**: installers for Windows, macOS and Linux, auto-update from GitHub Releases, local error logs and problem reports, TablePlus connection import, open-source release

## Next

- Code signing for Windows (SignPath for open-source projects) and Apple notarization
- SQLite table rebuilds for column type, null, default and foreign key changes
- More connection importers (DBeaver, DataGrip, pgAdmin)
- Snowflake testing against a real account
- Oracle and CockroachDB adapters
- Translations

Ideas and votes are welcome in the issue tracker.
