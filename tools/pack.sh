#!/bin/sh
# Construit le zip à envoyer sur le Chrome Web Store, sans les tests ni les outils.
set -e
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./manifest.json').version")
mkdir -p dist
OUT="dist/cinehalo-$VERSION.zip"
rm -f "$OUT"
zip -qr "$OUT" manifest.json _locales src \
  icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png
echo "$OUT"
