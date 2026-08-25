#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-dev}"
FRANKENPHP_VERSION="${FRANKENPHP_VERSION:-1.12.7}"
EXTRACTOR_DIR="${STATIC_EXTRACT_PHP_DIR:-$ROOT_DIR/../static-extract-php}"
NAME="parser-php-${VERSION}-linux-x64"
STAGE="$ROOT_DIR/target/release/$NAME"
DIST="$ROOT_DIR/dist"

test -f "$EXTRACTOR_DIR/composer.json" || { echo "static-extract-php sibling is required" >&2; exit 1; }
(cd "$ROOT_DIR" && composer install --no-dev --classmap-authoritative --no-interaction)
rm -rf "$STAGE"
mkdir -p "$STAGE/bin" "$STAGE/app" "$STAGE/runtime" "$DIST"
cp -R "$ROOT_DIR/bin" "$ROOT_DIR/src" "$ROOT_DIR/composer.json" "$STAGE/app/"
cp -RL "$ROOT_DIR/vendor" "$STAGE/app/vendor"
curl -fL --retry 3 \
  "https://github.com/php/frankenphp/releases/download/v${FRANKENPHP_VERSION}/frankenphp-linux-x86_64" \
  -o "$STAGE/runtime/frankenphp"
chmod +x "$STAGE/runtime/frankenphp"
install -m 0755 "$ROOT_DIR/packaging/parser-php" "$STAGE/bin/parser-php"
install -m 0755 "$ROOT_DIR/packaging/install.sh" "$STAGE/install.sh"
printf '%s\n' "$VERSION" > "$STAGE/VERSION"
printf 'FrankenPHP %s\n' "$FRANKENPHP_VERSION" > "$STAGE/RUNTIME-VERSIONS"
tar -C "$ROOT_DIR/target/release" -czf "$DIST/$NAME.tar.gz" "$NAME"
sha256sum "$DIST/$NAME.tar.gz" > "$DIST/$NAME.tar.gz.sha256"
printf '%s\n' "$DIST/$NAME.tar.gz"
