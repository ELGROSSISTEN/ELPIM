# CLAUDE.MD

## ePIM engineering guardrails

- Keep strict TypeScript enabled in all packages.
- Preserve sync invariants:
  - every write creates `Snapshot` + `ChangeLog`
  - outbound writes enqueue a `SyncJob`
  - webhook ingest uses idempotency keys
- Mapping direction and conflict policy must be respected by all sync paths.
- For TWO_WAY conflicts inside window, default to warning + hold unless policy resolves automatically.
- Never store Shopify Admin token or OpenAI API key in plaintext; always encrypt at rest with `MASTER_ENCRYPTION_KEY`.
- Avoid schema-breaking changes without migration notes.
- Keep web UI flows simple and explicit: bulk edit, save patch, visible pending sync state.
- Maintain structured logs and health endpoints (`/health`, `/metrics` on API; `/health` on worker).
