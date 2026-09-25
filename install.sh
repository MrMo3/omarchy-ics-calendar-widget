#!/usr/bin/env bash
# Installs (or uninstalls with --uninstall) the Work Calendar bar widget for Omarchy.
set -euo pipefail

ID="mrmoe.outlook-calendar"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/plugin"
DEST="$HOME/.config/omarchy/plugins/$ID"
SETTINGS="$HOME/.local/state/omarchy/settings/outlook-calendar.json"

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -rf "$DEST"
  echo "Removed $DEST"
  echo "Also remove the \"$ID\" entry from the bar in ~/.config/omarchy/shell.json."
  echo "Your calendar URL file was left in place: $SETTINGS"
  exit 0
fi

mkdir -p "$DEST"
cp "$SRC"/* "$DEST"/
echo "Installed plugin to $DEST"

if [[ ! -f "$SETTINGS" ]]; then
  mkdir -p "$(dirname "$SETTINGS")"
  read -r -p "Paste your calendar's published .ics URL (or press Enter to set it later): " url
  printf '{\n  "icsUrl": "%s"\n}\n' "$url" > "$SETTINGS"
  chmod 600 "$SETTINGS"   # the URL is effectively a password for your calendar
  echo "Saved URL to $SETTINGS"
fi

cat <<MSG

One last step: add the widget to your bar in ~/.config/omarchy/shell.json,
inside the "right" (or "left") list:

    { "id": "$ID" },

Then restart the shell so it picks up the plugin.
MSG
