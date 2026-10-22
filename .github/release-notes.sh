#!/usr/bin/env bash
# Usage: release-notes.sh <version> <changelog> <notes-out>
# Prints the release title for <version> ("v1.2.3 – title") and writes that
# version's CHANGELOG.md section body to <notes-out>. Fails if the section is
# missing or empty, so a version bump never publishes a release without notes.
set -euo pipefail

version="$1" changelog="$2" out="$3"

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "invalid version: '$version'" >&2; exit 1; }

# Heading is "## <version> – <title>" (en dash or plain hyphen).
heading=$(grep -m1 -E "^## ${version//./\\.}[[:space:]]+(–|-)[[:space:]]+" "$changelog" || true)
[ -n "$heading" ] || { echo "CHANGELOG.md has no '## $version – <title>' section" >&2; exit 1; }
title=$(printf '%s' "$heading" | sed -E "s/^## ${version//./\\.}[[:space:]]+(–|-)[[:space:]]+//")
[ -n "$title" ] || { echo "CHANGELOG.md section for $version has no title" >&2; exit 1; }

# Body: everything after the heading up to the next "## " heading, trimmed.
awk -v h="$heading" '
  $0 == h { on = 1; next }
  on && /^## / { exit }
  on { print }
' "$changelog" | sed -e '/./,$!d' | sed -e ':a' -e '/^\n*$/{$d;N;ba' -e '}' > "$out"
[ -s "$out" ] || { echo "CHANGELOG.md section for $version is empty" >&2; exit 1; }

printf 'v%s – %s\n' "$version" "$title"
