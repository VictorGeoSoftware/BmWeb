#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  ''|--dev) ;;
  *) printf 'Uso: %s [--dev]\n' "$0" >&2; exit 2 ;;
esac

cd -- "$(dirname -- "$0")"
printf 'BmWeb: %s\n' "$PWD"

if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  printf 'Se requiere Node 20 con npm, como en CI.\n' >&2
  exit 1
fi

if [[ ! -x node_modules/.bin/tsc || ! -x node_modules/.bin/vitest ]]; then
  printf 'Faltan dependencias. Ejecuta npm ci en BmWeb y vuelve a intentar.\n' >&2
  exit 1
fi

npm run typecheck
npm test

if [[ "${1:-}" == --dev ]]; then
  exec npm run dev
fi

printf 'Arranque local (con Firebase y backend de QA configurados): ./init.sh --dev\n'
