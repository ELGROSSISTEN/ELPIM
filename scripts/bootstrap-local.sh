#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PG_BIN_DIR="/opt/homebrew/opt/postgresql@16/bin"
PG_DATA_DIR="$ROOT_DIR/.local/postgres"
PG_PORT="5433"
DB_NAME="elpim"
DB_USER="${USER:-elpim}"

if [[ ! -f "$ROOT_DIR/.env" ]]; then
  cat > "$ROOT_DIR/.env" <<EOF
DATABASE_URL=postgresql://${DB_USER}@localhost:${PG_PORT}/${DB_NAME}
REDIS_URL=redis://localhost:6379
JWT_SECRET=dev_jwt_secret_change_me_12345
MASTER_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
SHOPIFY_WEBHOOK_SECRET=replace_me
SHOPIFY_WEBHOOK_CALLBACK_BASE_URL=http://localhost:4000
NEXT_PUBLIC_API_URL=http://localhost:4000
WORKER_HEALTH_PORT=4100
EOF
  echo "Created .env with local defaults"
fi

if ! command -v "$PG_BIN_DIR/psql" >/dev/null 2>&1; then
  echo "PostgreSQL @16 not found at $PG_BIN_DIR"
  echo "Install with: brew install postgresql@16"
  exit 1
fi

mkdir -p "$PG_DATA_DIR"
if [[ ! -f "$PG_DATA_DIR/PG_VERSION" ]]; then
  "$PG_BIN_DIR/initdb" -D "$PG_DATA_DIR" >/tmp/elpim-initdb.log 2>&1
fi

if ! nc -z localhost "$PG_PORT" >/dev/null 2>&1; then
  "$PG_BIN_DIR/pg_ctl" -D "$PG_DATA_DIR" -l "$PG_DATA_DIR/server.log" -o "-p ${PG_PORT}" start
fi

"$PG_BIN_DIR/createdb" -p "$PG_PORT" "$DB_NAME" >/dev/null 2>&1 || true

if ! nc -z localhost 6379 >/dev/null 2>&1; then
  echo "Redis is not running on localhost:6379"
  echo "Start Redis first (e.g. 'brew services start redis' or docker compose)."
  exit 1
fi

set -a
source "$ROOT_DIR/.env"
set +a

pnpm i
pnpm db:generate
pnpm --filter @epim/db exec prisma db push
pnpm db:seed

echo "Bootstrap complete. Starting dev services..."
pnpm dev
