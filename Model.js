// Minimal RFC5545 (iCalendar) reader: enough to pull VEVENTs out of an
// Outlook/Office365 "publish calendar" .ics feed and expand simple
// recurrences for a bar widget + popup. Not a general-purpose ICS library —
// no VALARM handling, no BYSETPOS/BYWEEKNO, etc.
//
// Timezone note: a DTSTART;TZID=... is resolved through the feed's own
// VTIMEZONE block for that TZID (Outlook always includes one, with simple
// yearly "Nth weekday of month" transition rules). A TZID with no matching
// VTIMEZONE, or a floating time with no TZID, is treated as wall-clock time
// in the system's local timezone. Recurrences are expanded in the event's
// own wall-clock time, so a meeting set in another timezone shifts in local
// time when only one side observes daylight saving.
//
// Times are handled in two forms: "wall" ms are the event's local clock
// fields stored as if they were UTC (Date.UTC(y, m, d, h, mi, s)), and
// plain ms are real instants. A zone ({ kind: "utc" | "local" | "tz" })
// converts wall to real.

var DAY_MS = 24 * 60 * 60 * 1000
var MAX_OCCURRENCES_PER_RULE = 500
// The feed is untrusted input, so bound the work a hostile or huge one can
// cause: events read from the file, occurrences produced from them, and the
// search for a month that has an Nth weekday.
var MAX_EVENTS = 5000
var MAX_OCCURRENCES = 2000
var MAX_MONTH_SEARCH = 24
var MAX_TIMEZONES = 100
var MAX_TZ_RULES = 10
var LOCAL_ZONE = { kind: "local" }
var UTC_ZONE = { kind: "utc" }
var DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }

function pad2(n) { return (n < 10 ? "0" : "") + n }

// RFC5545 line unfolding: a line starting with a space or tab is a
// continuation of the previous line.
function unfold(raw) {
  var lines = String(raw || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
  var out = []
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if ((line[0] === " " || line[0] === "\t") && out.length > 0) {
      out[out.length - 1] += line.slice(1)
    } else {
      out.push(line)
    }
  }
  return out
}

// "NAME;PARAM=VALUE;PARAM2=VALUE2:the value" -> { name, params, value }
function parseLine(line) {
  var colon = line.indexOf(":")
  if (colon < 0) return null
  var head = line.slice(0, colon)
  var value = line.slice(colon + 1)
  var parts = head.split(";")
  var name = parts[0].toUpperCase()
  var params = {}
  for (var i = 1; i < parts.length; i++) {
    var eq = parts[i].indexOf("=")
    if (eq < 0) continue
    params[parts[i].slice(0, eq).toUpperCase()] = parts[i].slice(eq + 1)
  }
  return { name: name, params: params, value: value }
}

function unescapeText(value) {
  return String(value || "")
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
}

// "+1000" / "-0430" -> offset from UTC in minutes, or null.
function parseUtcOffset(value) {
  var m = String(value || "").trim().match(/^([+-])(\d{2})(\d{2})(?:\d{2})?$/)
  if (!m) return null
  var mins = parseInt(m[2], 10) * 60 + parseInt(m[3], 10)
  return m[1] === "-" ? -mins : mins
}

// The nth (or, if negative, last-nth) occurrence of a weekday in a given
// month, as wall ms, e.g. ordinal=4, dow=WE -> the 4th Wednesday. Returns
// null if that ordinal doesn't exist in the month (e.g. a 5th occurrence
// some months).
function nthWeekdayOfMonth(year, month, dow, ordinal, h, mi, se) {
  if (ordinal > 0) {
    var firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay()
    var day = 1 + (dow - firstDow + 7) % 7 + (ordinal - 1) * 7
    if (day > daysInMonth(year, month)) return null
    return Date.UTC(year, month, day, h, mi, se)
  }
  var lastDay = daysInMonth(year, month)
  var lastDow = new Date(Date.UTC(year, month, lastDay)).getUTCDay()
  var day2 = lastDay - (lastDow - dow + 7) % 7 + (ordinal + 1) * 7
  if (day2 < 1) return null
  return Date.UTC(year, month, day2, h, mi, se)
}

// One STANDARD/DAYLIGHT sub-component -> a rule, or null if unusable. A
// rule takes effect at its onset (wall time) every year if it has a yearly
// RRULE, otherwise once at its DTSTART.
function normalizeTzRule(props) {
  var offset = parseUtcOffset(props.TZOFFSETTO ? props.TZOFFSETTO.value : "")
  var start = props.DTSTART ? parseDateValue(props.DTSTART.value, props.DTSTART.params) : null
  if (offset === null || !start) return null
  var rule = { offsetMin: offset, startWall: start.wall, yearly: null }
  var rr = props.RRULE ? ruleParams(props.RRULE.value) : null
  if (rr && String(rr.FREQ || "").toUpperCase() === "YEARLY") {
    var s = new Date(start.wall)
    var month = rr.BYMONTH ? parseInt(rr.BYMONTH, 10) - 1 : s.getUTCMonth()
    if (!(month >= 0 && month <= 11)) return null
    var byday = rr.BYDAY ? String(rr.BYDAY).match(/^([+-]?\d+)([A-Z]{2})$/) : null
    var ordinal = byday ? parseInt(byday[1], 10) : 0
    if (byday && (DOW[byday[2]] === undefined || ordinal === 0 || ordinal > 5 || ordinal < -5)) return null
    rule.yearly = {
      month: month, dow: byday ? DOW[byday[2]] : -1, ordinal: ordinal, day: s.getUTCDate(),
      h: s.getUTCHours(), mi: s.getUTCMinutes(), se: s.getUTCSeconds()
    }
  }
  return rule
}

// When a rule last took effect in a given year at or before wallMs, or
// null if it hadn't yet that year.
function tzRuleOnset(rule, year, wallMs) {
  var onset
  if (rule.yearly) {
    var y = rule.yearly
    onset = y.dow >= 0
      ? nthWeekdayOfMonth(year, y.month, y.dow, y.ordinal, y.h, y.mi, y.se)
      : Date.UTC(year, y.month, Math.min(y.day, daysInMonth(year, y.month)), y.h, y.mi, y.se)
    if (onset !== null && onset < rule.startWall) onset = null
  } else {
    onset = rule.startWall
  }
  return onset !== null && onset <= wallMs ? onset : null
}

// UTC offset (minutes) in force at a wall-clock time in a VTIMEZONE: the
// rule with the latest onset at or before it, looking back to the previous
// year (e.g. January sits under the rule that started last October).
function tzOffsetAt(tz, wallMs) {
  var year = new Date(wallMs).getUTCFullYear()
  var best = null, bestOnset = -Infinity
  for (var back = 0; back <= 1 && best === null; back++) {
    var probe = back === 0 ? wallMs : Date.UTC(year - 1, 11, 31, 23, 59, 59)
    for (var i = 0; i < tz.rules.length; i++) {
      var onset = tzRuleOnset(tz.rules[i], year - back, probe)
      if (onset !== null && onset >= bestOnset) { best = tz.rules[i]; bestOnset = onset }
    }
  }
  // Before every rule's first onset: fall back to the first rule listed.
  return (best || tz.rules[0]).offsetMin
}

// Wall ms in a zone -> real ms.
function wallToMs(wallMs, zone) {
  if (!zone || zone.kind === "local") {
    var d = new Date(wallMs)
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
                    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), 0).getTime()
  }
  if (zone.kind === "utc") return wallMs
  return wallMs - tzOffsetAt(zone, wallMs) * 60000
}

// Parses a DATE ("20260131") or DATE-TIME ("20260131T090000" / "...Z")
// value into { ms, wall, zone, allDay }. A TZID param is looked up in
// timezones (TZID -> VTIMEZONE, from parseTimezones); see module note.
function parseDateValue(value, params, timezones) {
  var v = String(value || "").trim()
  var isDateOnly = (params && params.VALUE === "DATE") || /^\d{8}$/.test(v)

  var m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/)
  if (!m) return null

  var year = parseInt(m[1], 10)
  var month = parseInt(m[2], 10) - 1
  var day = parseInt(m[3], 10)

  if (isDateOnly || m[4] === undefined) {
    var dateWall = Date.UTC(year, month, day)
    return { ms: wallToMs(dateWall, LOCAL_ZONE), wall: dateWall, zone: LOCAL_ZONE, allDay: true }
  }

  var wall = Date.UTC(year, month, day, parseInt(m[4], 10), parseInt(m[5], 10), parseInt(m[6], 10))
  var zone = LOCAL_ZONE
  if (m[7] === "Z") {
    zone = UTC_ZONE
  } else if (params && params.TZID && timezones) {
    var tzid = String(params.TZID).replace(/^"|"$/g, "")
    if (Object.prototype.hasOwnProperty.call(timezones, tzid)) zone = timezones[tzid]
  }
  return { ms: wallToMs(wall, zone), wall: wall, zone: zone, allDay: false }
}

// One VEVENT block's raw properties -> a normalized event object, or null
// for a block missing the fields we need.
function normalizeEvent(props, timezones) {
  if (!props.DTSTART) return null
  var start = parseDateValue(props.DTSTART.value, props.DTSTART.params, timezones)
  if (!start) return null

  var end = null
  if (props.DTEND) end = parseDateValue(props.DTEND.value, props.DTEND.params, timezones)
  if (!end) {
    // No DTEND: DURATION isn't parsed here, so fall back to a sane default
    // (30 min timed, one day all-day) rather than a zero-length block.
    end = { ms: start.ms + (start.allDay ? DAY_MS : 30 * 60 * 1000), allDay: start.allDay }
  }

  var recurrenceId = null
  if (props["RECURRENCE-ID"]) recurrenceId = parseDateValue(props["RECURRENCE-ID"].value, props["RECURRENCE-ID"].params, timezones)

  var exdates = []
  for (var i = 0; i < (props.EXDATE_LIST || []).length; i++) {
    var ex = parseDateValue(props.EXDATE_LIST[i].value, props.EXDATE_LIST[i].params, timezones)
    if (ex) exdates.push(ex.ms)
  }

  return {
    uid: props.UID ? props.UID.value : "",
    summary: unescapeText(props.SUMMARY ? props.SUMMARY.value : "(no title)"),
    location: unescapeText(props.LOCATION ? props.LOCATION.value : ""),
    status: props.STATUS ? String(props.STATUS.value || "").toUpperCase() : "",
    startMs: start.ms,
    startWall: start.wall,
    zone: start.zone,
    endMs: end.ms,
    allDay: start.allDay,
    rrule: props.RRULE ? props.RRULE.value : "",
    exdates: exdates,
    recurrenceIdMs: recurrenceId ? recurrenceId.ms : null
  }
}

// Unfolded .ics lines -> { TZID: { kind: "tz", rules: [...] } } for every
// VTIMEZONE with at least one usable STANDARD/DAYLIGHT rule.
function parseTimezones(lines) {
  // No prototype, so a hostile TZID like "__proto__" is just a key.
  var timezones = Object.create(null)
  var count = 0
  var tzid = null, rules = null, sub = null

  for (var i = 0; i < lines.length && count < MAX_TIMEZONES; i++) {
    var line = lines[i]
    if (line === "BEGIN:VTIMEZONE") { tzid = null; rules = []; sub = null; continue }
    if (rules === null) continue
    if (line === "END:VTIMEZONE") {
      if (tzid && rules.length > 0) {
        timezones[tzid] = { kind: "tz", rules: rules }
        count++
      }
      rules = null
      continue
    }
    if (line === "BEGIN:STANDARD" || line === "BEGIN:DAYLIGHT") { sub = {}; continue }
    if (line === "END:STANDARD" || line === "END:DAYLIGHT") {
      var rule = sub ? normalizeTzRule(sub) : null
      if (rule && rules.length < MAX_TZ_RULES) rules.push(rule)
      sub = null
      continue
    }
    var parsed = parseLine(line)
    if (!parsed) continue
    if (sub) sub[parsed.name] = parsed
    else if (parsed.name === "TZID") tzid = parsed.value
  }
  return timezones
}

// Full .ics text -> array of normalized VEVENT objects (master events and
// RECURRENCE-ID overrides both included, undifferentiated).
function parseICS(raw) {
  var lines = unfold(raw)
  var timezones = parseTimezones(lines)
  var events = []
  var current = null

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (line === "BEGIN:VEVENT") {
      current = {}
      continue
    }
    if (line === "END:VEVENT") {
      if (current) {
        var ev = normalizeEvent(current, timezones)
        if (ev) events.push(ev)
        if (events.length >= MAX_EVENTS) break
      }
      current = null
      continue
    }
    if (!current) continue

    var parsed = parseLine(line)
    if (!parsed) continue

    if (parsed.name === "EXDATE") {
      current.EXDATE_LIST = current.EXDATE_LIST || []
      var vals = parsed.value.split(",")
      for (var j = 0; j < vals.length; j++)
        current.EXDATE_LIST.push({ value: vals[j], params: parsed.params })
    } else {
      current[parsed.name] = parsed
    }
  }
  return events
}

function ruleParams(rrule) {
  var out = {}
  var parts = String(rrule || "").split(";")
  for (var i = 0; i < parts.length; i++) {
    var eq = parts[i].indexOf("=")
    if (eq < 0) continue
    out[parts[i].slice(0, eq).toUpperCase()] = parts[i].slice(eq + 1)
  }
  return out
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate()
}

// Expands one recurring master event into occurrence start times (real ms),
// bounded to [rangeStartMs, rangeEndMs] and by the rule's own COUNT/UNTIL.
// Stepping happens on wall ms in the event's zone, so the meeting keeps its
// clock time there across daylight-saving changes. Deliberately supports
// only DAILY/WEEKLY/MONTHLY/YEARLY with a single INTERVAL, (for WEEKLY)
// BYDAY, and (for MONTHLY) a single ordinal BYDAY like "4WE" — the common
// cases for meeting invites.
function expandRecurrence(startWall, zone, rrule, exdateSet, rangeStartMs, rangeEndMs) {
  var rule = ruleParams(rrule)
  var freq = String(rule.FREQ || "").toUpperCase()
  if (!freq) return [wallToMs(startWall, zone)]

  var interval = Math.max(1, parseInt(rule.INTERVAL, 10) || 1)
  var count = rule.COUNT ? parseInt(rule.COUNT, 10) : -1
  var until = null
  if (rule.UNTIL) {
    // A UTC UNTIL is an instant; otherwise it's in the event's own zone,
    // and a bare date includes that whole day.
    var u = parseDateValue(rule.UNTIL, {})
    if (u) until = u.zone === UTC_ZONE ? u.ms : wallToMs(u.wall + (u.allDay ? DAY_MS - 1 : 0), zone)
  }

  var start = new Date(startWall)
  var h = start.getUTCHours(), mi = start.getUTCMinutes(), se = start.getUTCSeconds()
  var results = []
  var generated = 0

  function withinLimits(ms) {
    if (until !== null && ms > until) return false
    return true
  }

  function accept(ms) {
    generated++
    if (count >= 0 && generated > count) return false
    if (!withinLimits(ms)) return false
    if (exdateSet[ms]) return true // still counts toward COUNT, just excluded from output
    if (ms >= rangeStartMs && ms <= rangeEndMs) results.push(ms)
    return true
  }

  if (freq === "WEEKLY") {
    var byday = rule.BYDAY ? rule.BYDAY.split(",") : null
    var dows = []
    if (byday) {
      for (var i = 0; i < byday.length; i++) {
        var code = byday[i].replace(/^[+-]?\d+/, "")
        if (DOW[code] !== undefined) dows.push(DOW[code])
      }
    }
    if (dows.length === 0) dows = [start.getUTCDay()]
    dows.sort(function(a, b) { return a - b })

    var wkst = 1 // MO, RFC5545 default
    var backToWeekStart = (start.getUTCDay() - wkst + 7) % 7
    var y0 = start.getUTCFullYear(), m0 = start.getUTCMonth(), d0 = start.getUTCDate() - backToWeekStart

    var weekIndex = 0
    var safety = 0
    while (safety++ < MAX_OCCURRENCES_PER_RULE * 4) {
      var weekStartDay = d0 + weekIndex * 7 * interval
      var anyInRange = false
      for (var d = 0; d < dows.length; d++) {
        var offset = (dows[d] - wkst + 7) % 7
        var wall = Date.UTC(y0, m0, weekStartDay + offset, h, mi, se)
        if (wall < startWall) continue
        var ms = wallToMs(wall, zone)
        if (!accept(ms)) { if (count >= 0 && generated > count) { weekIndex = -1; break } }
        if (ms <= rangeEndMs) anyInRange = true
      }
      if (weekIndex === -1) break
      if (count >= 0 && generated > count) break
      if (wallToMs(Date.UTC(y0, m0, weekStartDay, h, mi, se), zone) > rangeEndMs && !anyInRange) break
      weekIndex++
      if (results.length >= MAX_OCCURRENCES_PER_RULE) break
    }
    return results
  }

  // DAILY / MONTHLY / YEARLY: step a single anchor date forward.
  var cursor = new Date(startWall)
  var safetySteps = 0
  while (safetySteps++ < MAX_OCCURRENCES_PER_RULE) {
    var ms = wallToMs(cursor.getTime(), zone)
    if (ms > rangeEndMs && (until === null || ms > until)) break
    if (!accept(ms)) break
    if (count >= 0 && generated >= count && ms >= rangeEndMs) break
    if (ms > rangeEndMs) break

    if (freq === "DAILY") {
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate() + interval, h, mi, se))
    } else if (freq === "MONTHLY") {
      var monthlyByday = rule.BYDAY ? rule.BYDAY.match(/^(-?\d+)([A-Z]{2})$/) : null
      var targetMonth = cursor.getUTCMonth() + interval
      var targetYear = cursor.getUTCFullYear() + Math.floor(targetMonth / 12)
      targetMonth = ((targetMonth % 12) + 12) % 12
      if (monthlyByday && DOW[monthlyByday[2]] !== undefined) {
        var ordinal = parseInt(monthlyByday[1], 10)
        if (ordinal === 0 || ordinal > 5 || ordinal < -5) break // not a real ordinal
        var nextByday = nthWeekdayOfMonth(targetYear, targetMonth, DOW[monthlyByday[2]], ordinal, h, mi, se)
        var monthSearch = 0
        // Ordinal doesn't exist in this month (e.g. a "5th" weekday) — skip
        // to the following month instead of falling back to a wrong date.
        while (nextByday === null) {
          if (++monthSearch > MAX_MONTH_SEARCH) return results
          targetMonth += interval
          targetYear += Math.floor(targetMonth / 12)
          targetMonth = ((targetMonth % 12) + 12) % 12
          nextByday = nthWeekdayOfMonth(targetYear, targetMonth, DOW[monthlyByday[2]], ordinal, h, mi, se)
        }
        cursor = new Date(nextByday)
      } else {
        var day = Math.min(start.getUTCDate(), daysInMonth(targetYear, targetMonth))
        cursor = new Date(Date.UTC(targetYear, targetMonth, day, h, mi, se))
      }
    } else if (freq === "YEARLY") {
      cursor = new Date(Date.UTC(cursor.getUTCFullYear() + interval, cursor.getUTCMonth(), cursor.getUTCDate(), h, mi, se))
    } else {
      break // unsupported FREQ
    }
  }
  return results
}

// Master + override VEVENTs -> a flat, sorted list of concrete occurrences
// overlapping [nowMs, horizonMs], each { startMs, endMs, allDay, summary,
// location, uid }.
function buildOccurrences(events, nowMs, horizonMs) {
  var masters = []
  var overrides = {} // "uid|recurrenceIdMs" -> event

  for (var i = 0; i < events.length; i++) {
    var ev = events[i]
    if (ev.recurrenceIdMs !== null) {
      overrides[ev.uid + "|" + ev.recurrenceIdMs] = ev
    } else {
      masters.push(ev)
    }
  }

  var rangeStart = nowMs - DAY_MS // include today's already-started events
  var occurrences = []

  for (var m = 0; m < masters.length && occurrences.length < MAX_OCCURRENCES; m++) {
    var master = masters[m]
    var duration = master.endMs - master.startMs

    if (master.rrule) {
      var exdateSet = {}
      for (var e = 0; e < master.exdates.length; e++) exdateSet[master.exdates[e]] = true

      var starts = expandRecurrence(master.startWall, master.zone, master.rrule, exdateSet, rangeStart, horizonMs)
      for (var s = 0; s < starts.length; s++) {
        var startMs = starts[s]
        if (exdateSet[startMs]) continue
        // Overridden slots are emitted from the overrides loop below.
        if (overrides[master.uid + "|" + startMs]) continue
        occurrences.push({
          startMs: startMs, endMs: startMs + duration, allDay: master.allDay,
          summary: master.summary, location: master.location, uid: master.uid
        })
      }
    } else {
      if (master.status === "CANCELLED") continue
      if (master.endMs >= rangeStart && master.startMs <= horizonMs) {
        occurrences.push({
          startMs: master.startMs, endMs: master.endMs, allDay: master.allDay,
          summary: master.summary, location: master.location, uid: master.uid
        })
      }
    }
  }

  // A moved occurrence is placed by its own DTSTART, not its original slot:
  // a meeting moved from yesterday to today has its RECURRENCE-ID outside
  // the expansion range, so matching it from the master's expansion alone
  // would drop it.
  for (var k in overrides) {
    if (occurrences.length >= MAX_OCCURRENCES) break
    var ov = overrides[k]
    if (ov.status === "CANCELLED") continue
    if (ov.endMs >= rangeStart && ov.startMs <= horizonMs) {
      occurrences.push({
        startMs: ov.startMs, endMs: ov.endMs, allDay: ov.allDay,
        summary: ov.summary, location: ov.location, uid: ov.uid
      })
    }
  }

  // rangeStart looks a day into the past purely so recurrence expansion
  // doesn't drop an occurrence sitting right at today's boundary; occurrences
  // that have actually finished are dropped here instead.
  occurrences = occurrences.filter(function(o) { return o.endMs >= nowMs })
  occurrences.sort(function(a, b) { return a.startMs - b.startMs })
  return occurrences
}

function isSameLocalDay(aMs, bMs) {
  var a = new Date(aMs), b = new Date(bMs)
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

var WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
var MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function dayLabel(ms, nowMs) {
  if (isSameLocalDay(ms, nowMs)) return "TODAY"
  if (isSameLocalDay(ms, nowMs + DAY_MS)) return "TOMORROW"
  var d = new Date(ms)
  return WEEKDAY_NAMES[d.getDay()].slice(0, 3).toUpperCase() + " " + d.getDate() + " " + MONTH_NAMES[d.getMonth()].toUpperCase()
}

function timeLabel(occurrence) {
  if (occurrence.allDay) return "All day"
  var s = new Date(occurrence.startMs), e = new Date(occurrence.endMs)
  return pad2(s.getHours()) + ":" + pad2(s.getMinutes()) + " – " + pad2(e.getHours()) + ":" + pad2(e.getMinutes())
}

// Text for the bar pill: the event happening now, else the next one, else a
// quiet default. Kept short — the panel is where detail belongs.
// Truncates just the summary portion so a long meeting title can't blow out
// the bar's width — the full title is always available in the popup list.
function truncate(text, maxLen) {
  var s = String(text || "")
  if (s.length <= maxLen) return s
  return s.slice(0, Math.max(0, maxLen - 1)).replace(/\s+$/, "") + "…"
}

function barLabel(occurrences, nowMs, maxSummaryLen) {
  var cap = maxSummaryLen || 22
  if (!occurrences || occurrences.length === 0) return "No events"
  for (var i = 0; i < occurrences.length; i++) {
    var o = occurrences[i]
    if (o.startMs <= nowMs && nowMs < o.endMs) return "Now: " + truncate(o.summary, cap)
  }
  for (var j = 0; j < occurrences.length; j++) {
    var next = occurrences[j]
    if (next.startMs > nowMs) {
      if (next.allDay) return truncate(next.summary, cap)
      var d = new Date(next.startMs)
      return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + " " + truncate(next.summary, cap)
    }
  }
  return "No events"
}

if (typeof module !== "undefined") {
  module.exports = {
    unfold: unfold,
    parseLine: parseLine,
    parseDateValue: parseDateValue,
    parseTimezones: parseTimezones,
    wallToMs: wallToMs,
    parseICS: parseICS,
    expandRecurrence: expandRecurrence,
    buildOccurrences: buildOccurrences,
    isSameLocalDay: isSameLocalDay,
    dayLabel: dayLabel,
    timeLabel: timeLabel,
    barLabel: barLabel
  }
}
