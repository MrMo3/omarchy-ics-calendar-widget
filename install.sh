#!/usr/bin/env bash
# Installs (or uninstalls with --uninstall) the ICS Calendar bar widget for Omarchy.
set -euo pipefail

ID="mrmoe.ics-calendar"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.config/omarchy/plugins/$ID"
SETTINGS="$HOME/.local/state/omarchy/settings/ics-calendar.json"

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -rf "$DEST"
  echo "Removed $DEST"
  echo "Also remove the \"$ID\" entry from the bar in ~/.config/omarchy/shell.json."
  echo "Your calendar URL file was left in place: $SETTINGS"
  exit 0
fi

mkdir -p "$DEST"
cp "$SRC"/{BarWidget.qml,Panel.qml,Model.js,manifest.json} "$DEST"/
echo "Installed plugin to $DEST"

if [[ ! -f "$SETTINGS" ]]; then
  mkdir -p "$(dirname "$SETTINGS")"
  echo "You need your calendar's published .ics link (see the README: \"Getting your calendar URL\")."
  read -r -p "Paste it here (or press Enter to set it later): " url
  if [[ -n "$url" && ! "$url" =~ ^(https|webcal):// ]]; then
    echo "That doesn't look like an https:// link, so it was not saved. Set it later in $SETTINGS"
    url=""
  fi
  url="${url//\\/\\\\}"; url="${url//\"/\\\"}"   # escape backslashes/quotes so the JSON stays valid
  # The URL is effectively a password for your calendar: create the file
  # readable by you alone from the start, not chmod it afterwards.
  ( umask 077; printf '{\n  "icsUrl": "%s"\n}\n' "$url" > "$SETTINGS" )
  echo "Saved URL to $SETTINGS"
fi

cat <<MSG

One last step: add the widget to your bar in ~/.config/omarchy/shell.json,
inside the "right" (or "left") list:

    { "id": "$ID" },

Then restart the shell so it picks up the plugin.
MSG
