#!/usr/bin/env bash
set -euo pipefail

# Deploy ePIM monorepo to Railway
# Usage: ./scripts/deploy-railway.sh [api|worker|web|all]

PROJECT="elpim-prod"
ENV="production"
TARGET="${1:-all}"

cleanup() {
  rm -f railway.toml railway.toml.*
}

trap cleanup EXIT

deploy_service() {
  local service="$1"
  local dockerfile="$2"
  local toml_extra="${3:-}"
  local tmptoml
  tmptoml=$(mktemp railway.toml.XXXXXX)

  echo "━━━ Deploying $service ━━━"

  cat > "$tmptoml" << EOF
[build]
dockerfilePath = "$dockerfile"
$toml_extra
EOF
  cp "$tmptoml" railway.toml
  rm -f "$tmptoml"

  railway up --ci --service "$service"
  echo "✅ $service deployed"
}

case "$TARGET" in
  api)
    deploy_service "elpim-api" "Dockerfile.api" '[deploy]
healthcheckPath = "/health"
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3'
    ;;
  worker)
    deploy_service "elpim-worker" "Dockerfile.worker" '[deploy]
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3'
    ;;
  web)
    deploy_service "elpim-web" "Dockerfile.web" '[deploy]
healthcheckPath = "/"
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3'
    ;;
  all)
    deploy_service "elpim-api" "Dockerfile.api" '[deploy]
healthcheckPath = "/health"
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3'

    deploy_service "elpim-worker" "Dockerfile.worker" '[deploy]
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3'

    deploy_service "elpim-web" "Dockerfile.web" '[deploy]
healthcheckPath = "/"
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 3'
    ;;
  *)
    echo "Usage: $0 [api|worker|web|all]"
    exit 1
    ;;
esac

echo "━━━ Deploy complete ━━━"
