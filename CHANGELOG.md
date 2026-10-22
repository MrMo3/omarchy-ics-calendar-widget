# Changelog

Each `## <version> – <title>` section becomes the GitHub release for that
version. Bumping `version` in `manifest.json` and pushing to `main`
publishes it automatically (see `.github/workflows/release.yml`).

## 1.0.4 – rescheduled meetings fix

- A meeting moved from its usual slot now always shows at its new time. Previously, an occurrence moved from yesterday to today could disappear from the bar
- No change to setup

## 1.0.3 – timezone fix

- Meeting times now use the timezone details included in the calendar feed, so meetings set in another timezone show at the correct local time, including across daylight-saving changes
- No change to setup

## 1.0.2 – security hardening

Addresses marketplace review feedback and a wider self-review.

- Calendar link is now passed to curl over stdin, so it no longer appears in the process list
- Downloads are capped at 2 MB
- Only https:// links are fetched (webcal:// is converted); other schemes are refused
- Parser work is bounded, so a hostile or huge feed can't freeze the shell
- Installer creates the settings file readable by the owner only from the start
- No change to normal behaviour

## 1.0.1 – marketplace-ready layout

- Plugin files moved to the repository root (required for the Omarchy plugin marketplace)
- README now lists requirements (Omarchy shell plugins, curl)
- Screenshot renamed to preview.png
- No functional changes to the widget

## 1.0.0 – first release

First public release of the Omarchy ICS Calendar Widget.

- Next calendar event in the Omarchy bar, with an upcoming-events popup
- Works with any published `.ics` calendar link (Outlook, Google, etc.)
- Handles recurring meetings
- No login, API keys or background service
- `install.sh` installs it and saves your calendar link

See the README for install steps.
