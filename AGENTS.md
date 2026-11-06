# AGENTS.md

The canonical guide for this repository is `CLAUDE.md` (written in Japanese). Read it before making changes: it has the commands, the file map (which file to open for which change), and the rules that must be preserved (CSRF header check, `sanitizeData()`, delegated event listeners).

- Write commit messages in Japanese.
- Never read files under `data/` directly — they hold the user's personal data, backups, and Google credentials. To view or change tasks, use `node cli.js help`. Use a temporary `DATA_DIR` with sample data for manual testing.
- Run `npm test` before committing.
