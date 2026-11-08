#!/usr/bin/env bash
# Build or live-preview the vault with a pinned Quartz 4 checkout.
#
#   scripts/quartz.sh serve   # http://localhost:8080 with hot reload
#   scripts/quartz.sh build   # static output in $QUARTZ_FRAMEWORK_DIR/public
#
# Quartz is cloned into .quartz-framework/ (git-ignored) instead of being
# vendored, so the vault stays a plain Obsidian repository. The framework reads
# `quartz.config.ts` from its own working directory, so the files in .quartz/
# are copied over the checkout on every run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUARTZ_REF="${QUARTZ_REF:-v4.5.2}"
QUARTZ_REPO="${QUARTZ_REPO:-https://github.com/jackyzha0/quartz.git}"
FW_DIR="${QUARTZ_FRAMEWORK_DIR:-$REPO_ROOT/.quartz-framework}"
OUT_DIR="${QUARTZ_OUTPUT_DIR:-$FW_DIR/public}"

cmd="${1:-build}"
case "$cmd" in
build | serve) ;;
*)
  echo "usage: $(basename "$0") [build|serve] [extra quartz args, e.g. --port 8099]" >&2
  exit 1
  ;;
esac
shift || true

if [[ ! -d "$FW_DIR/.git" ]]; then
  git clone --depth 1 --branch "$QUARTZ_REF" "$QUARTZ_REPO" "$FW_DIR"
fi

if [[ ! -d "$FW_DIR/node_modules" ]]; then
  (cd "$FW_DIR" && bun install)
fi

cp "$REPO_ROOT/.quartz/quartz.config.ts" "$FW_DIR/quartz.config.ts"
cp "$REPO_ROOT/.quartz/quartz.layout.ts" "$FW_DIR/quartz.layout.ts"
cp "$REPO_ROOT/.quartz/custom.scss" "$FW_DIR/quartz/styles/custom.scss"

cd "$FW_DIR"
if [[ "$cmd" == "serve" ]]; then
  exec bun ./quartz/bootstrap-cli.mjs build --serve --directory "$REPO_ROOT" --output "$OUT_DIR" "$@"
fi
exec bun ./quartz/bootstrap-cli.mjs build --directory "$REPO_ROOT" --output "$OUT_DIR" "$@"
