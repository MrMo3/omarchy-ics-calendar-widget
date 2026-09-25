# Omarchy ICS Calendar Widget

An [Omarchy](https://omarchy.org) bar widget that shows your next calendar
event in the top bar, with a popup listing upcoming events.

- Shows the event happening now, or the next one (`09:30 Team standup`)
- Click for a popup of upcoming events grouped by day
- Middle-click to refresh
- Handles recurring meetings (daily / weekly / monthly / yearly)
- Read-only and private: it only downloads a calendar feed; nothing is sent anywhere

**How it's different:** deliberately tiny. No login, no API keys, no app
registration, no background service. You paste one calendar link and that's it,
which suits work calendars where IT won't let you register apps. If you want
two-way sync, Google/CalDAV accounts, or a month grid, other Omarchy calendar
plugins do more.

![ICS Calendar in the Omarchy bar](preview.png)

Built for Outlook / Office 365 "publish calendar" feeds, but it should work with
any standard `.ics` feed (Google Calendar's "secret address in iCal format", etc.).

## Requirements

- Omarchy with shell plugin support (the Quattro shell)
- `curl` (used to download your calendar feed; installed by default on Omarchy)

## Install

```bash
git clone https://github.com/MrMo3/omarchy-ics-calendar-widget
cd omarchy-ics-calendar-widget
./install.sh
```

The script copies the plugin into `~/.config/omarchy/plugins/` and asks for
your calendar URL. Then add this to the `right` (or `left`) list of the bar in
`~/.config/omarchy/shell.json` and restart the shell:

```json
{ "id": "mrmoe.ics-calendar" }
```

## Getting your calendar URL

**Outlook on the web:** Settings → Calendar → Shared calendars → *Publish a
calendar* → pick your calendar, set permissions to "Can view all details", click
Publish, and copy the **ICS** link.

> **Treat this link like a password.** Anyone with it can read your calendar.
> Never commit it to Git or post it publicly. It's stored only in
> `~/.local/state/omarchy/settings/ics-calendar.json` (`icsUrl` key), which
> the installer makes readable by you alone. Your organisation may also block
> publishing calendars, so check with your IT admin.

## Security notes

- Only `https://` calendar links are fetched (`webcal://` links are converted to `https://`).
- Your link is passed to `curl` over stdin, so it never appears in the process list.
- Downloads are capped at 2 MB, and the parser limits how many events it will read, so a huge or hostile feed can't exhaust memory or freeze the shell.
- Event text is shown as plain text only. The widget never opens links or runs anything from your calendar.

## Limitations

- Timezones: events are treated as being in your machine's local timezone.
- Recurrence support covers the common meeting patterns, not every RFC 5545 rule.
- No alarms/reminders.

## Uninstall

```bash
./install.sh --uninstall
```

Then remove the entry from `shell.json`.

## License

MIT
