#!/bin/sh
set -e

echo "[entrypoint] Running database migrations..."
if node_modules/.bin/prisma migrate deploy --schema ./prisma/schema.prisma; then
  echo "[entrypoint] Migrations applied."
else
  echo "[entrypoint] Warning: migration step failed or returned non-zero — proceeding anyway."
fi

echo "[entrypoint] Starting API server..."
exec node dist/server.js
