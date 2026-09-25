// Minimal RFC5545 (iCalendar) reader: enough to pull VEVENTs out of an
// Outlook/Office365 "publish calendar" .ics feed and expand simple
// recurrences for a bar widget + popup. Not a general-purpose ICS library —
// no VALARM/VTIMEZONE handling, no BYSETPOS/BYWEEKNO, etc.
//
// Timezone note: a bare DTSTART;TZID=... is treated as wall-clock time in
// the system's own local timezone. That is correct whenever the calendar's
// events were created in the same timezone the machine runs in (the normal
// case for a personal work calendar) and wrong otherwise — there is no
// VTIMEZONE/IANA mapping here.

var DAY_MS = 24 * 60 * 60 * 1000
var MAX_OCCURRENCES_PER_RULE = 500
// The feed is untrusted input, so bound the work a hostile or huge one can
// cause: events read from the file, occurrences produced from them, and the
// search for a month that has an Nth weekday.
var MAX_EVENTS = 5000
var MAX_OCCURRENCES = 2000
var MAX_MONTH_SEARCH = 24
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

// Parses a DATE ("20260131") or DATE-TIME ("20260131T090000" / "...Z")
// value into { ms, allDay }. TZID is intentionally ignored (see module note).
function parseDateValue(value, params) {
  var v = String(value || "").trim()
  var isDateOnly = (params && params.VALUE === "DATE") || /^\d{8}$/.test(v)

  var m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/)
  if (!m) return null

  var year = parseInt(m[1], 10)
  var month = parseInt(m[2], 10) - 1
  var day = parseInt(m[3], 10)

  if (isDateOnly || m[4] === undefined) {
    return { ms: new Date(year, month, day, 0, 0, 0, 0).getTime(), allDay: true }
  }

  var hour = parseInt(m[4], 10)
  var minute = parseInt(m[5], 10)
  var second = parseInt(m[6], 10)
  var isUtc = m[7] === "Z"

  var ms = isUtc
    ? Date.UTC(year, month, day, hour, minute, second)
    : new Date(year, month, day, hour, minute, second, 0).getTime()
  return { ms: ms, allDay: false }
}

// One VEVENT block's raw properties -> a normalized event object, or null
// for a block missing the fields we need.
function normalizeEvent(props) {
  if (!props.DTSTART) return null
  var start = parseDateValue(props.DTSTART.value, props.DTSTART.params)
  if (!start) return null

  var end = null
  if (props.DTEND) end = parseDateValue(props.DTEND.value, props.DTEND.params)
  if (!end) {
    // No DTEND: DURATION isn't parsed here, so fall back to a sane default
    // (30 min timed, one day all-day) rather than a zero-length block.
    end = { ms: start.ms + (start.allDay ? DAY_MS : 30 * 60 * 1000), allDay: start.allDay }
  }

  var recurrenceId = null
  if (props["RECURRENCE-ID"]) recurrenceId = parseDateValue(props["RECURRENCE-ID"].value, props["RECURRENCE-ID"].params)

  var exdates = []
  for (var i = 0; i < (props.EXDATE_LIST || []).length; i++) {
    var ex = parseDateValue(props.EXDATE_LIST[i].value, props.EXDATE_LIST[i].params)
    if (ex) exdates.push(ex.ms)
  }

  return {
    uid: props.UID ? props.UID.value : "",
    summary: unescapeText(props.SUMMARY ? props.SUMMARY.value : "(no title)"),
    location: unescapeText(props.LOCATION ? props.LOCATION.value : ""),
    status: props.STATUS ? String(props.STATUS.value || "").toUpperCase() : "",
    startMs: start.ms,
    endMs: end.ms,
    allDay: start.allDay,
    rrule: props.RRULE ? props.RRULE.value : "",
    exdates: exdates,
    recurrenceIdMs: recurrenceId ? recurrenceId.ms : null
  }
}

// Full .ics text -> array of normalized VEVENT objects (master events and
// RECURRENCE-ID overrides both included, undifferentiated).
function parseICS(raw) {
  var lines = unfold(raw)
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
        var ev = normalizeEvent(current)
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

// The nth (or, if negative, last-nth) occurrence of a weekday in a given
// month, e.g. ordinal=4, dow=WE -> the 4th Wednesday. Returns null if that
// ordinal doesn't exist in the month (e.g. a 5th occurrence some months).
function nthWeekdayOfMonth(year, month, dow, ordinal, h, mi, se) {
  if (ordinal > 0) {
    var first = new Date(year, month, 1, h, mi, se, 0)
    var offset = (dow - first.getDay() + 7) % 7
    var day = 1 + offset + (ordinal - 1) * 7
    if (day > daysInMonth(year, month)) return null
    return new Date(year, month, day, h, mi, se, 0)
  }
  var last = new Date(year, month + 1, 0, h, mi, se, 0)
  var offsetLast = (last.getDay() - dow + 7) % 7
  var day2 = last.getDate() - offsetLast + (ordinal + 1) * 7
  if (day2 < 1) return null
  return new Date(year, month, day2, h, mi, se, 0)
}

// Expands one recurring master event into occurrence start times (ms),
// bounded to [rangeStartMs, rangeEndMs] and by the rule's own COUNT/UNTIL.
// Deliberately supports only DAILY/WEEKLY/MONTHLY/YEARLY with a single
// INTERVAL, (for WEEKLY) BYDAY, and (for MONTHLY) a single ordinal BYDAY
// like "4WE" — the common cases for meeting invites.
function expandRecurrence(startMs, rrule, exdateSet, rangeStartMs, rangeEndMs) {
  var rule = ruleParams(rrule)
  var freq = String(rule.FREQ || "").toUpperCase()
  if (!freq) return [startMs]

  var interval = Math.max(1, parseInt(rule.INTERVAL, 10) || 1)
  var count = rule.COUNT ? parseInt(rule.COUNT, 10) : -1
  var until = null
  if (rule.UNTIL) {
    var u = parseDateValue(rule.UNTIL, {})
    if (u) until = u.ms
  }

  var start = new Date(startMs)
  var h = start.getHours(), mi = start.getMinutes(), se = start.getSeconds()
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
    if (dows.length === 0) dows = [start.getDay()]
    dows.sort(function(a, b) { return a - b })

    var wkst = 1 // MO, RFC5545 default
    var startDow = start.getDay()
    var backToWeekStart = (startDow - wkst + 7) % 7
    var weekAnchor = new Date(start.getFullYear(), start.getMonth(), start.getDate() - backToWeekStart, h, mi, se, 0)

    var weekIndex = 0
    var safety = 0
    while (safety++ < MAX_OCCURRENCES_PER_RULE * 4) {
      var weekStartDate = new Date(weekAnchor.getFullYear(), weekAnchor.getMonth(), weekAnchor.getDate() + weekIndex * 7 * interval, h, mi, se, 0)
      var anyInRange = false
      for (var d = 0; d < dows.length; d++) {
        var offset = (dows[d] - wkst + 7) % 7
        var candidate = new Date(weekStartDate.getFullYear(), weekStartDate.getMonth(), weekStartDate.getDate() + offset, h, mi, se, 0)
        var ms = candidate.getTime()
        if (ms < startMs) continue
        if (!accept(ms)) { if (count >= 0 && generated > count) { weekIndex = -1; break } }
        if (ms <= rangeEndMs) anyInRange = true
      }
      if (weekIndex === -1) break
      if (count >= 0 && generated > count) break
      if (weekStartDate.getTime() > rangeEndMs && !anyInRange) break
      weekIndex++
      if (results.length >= MAX_OCCURRENCES_PER_RULE) break
    }
    return results
  }

  // DAILY / MONTHLY / YEARLY: step a single anchor date forward.
  var cursor = new Date(start.getTime())
  var safetySteps = 0
  while (safetySteps++ < MAX_OCCURRENCES_PER_RULE) {
    var ms = cursor.getTime()
    if (ms > rangeEndMs && (until === null || ms > until)) break
    if (!accept(ms)) break
    if (count >= 0 && generated >= count && ms >= rangeEndMs) break
    if (ms > rangeEndMs) break

    if (freq === "DAILY") {
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + interval, h, mi, se, 0)
    } else if (freq === "MONTHLY") {
      var monthlyByday = rule.BYDAY ? rule.BYDAY.match(/^(-?\d+)([A-Z]{2})$/) : null
      var targetMonth = cursor.getMonth() + interval
      var targetYear = cursor.getFullYear() + Math.floor(targetMonth / 12)
      targetMonth = ((targetMonth % 12) + 12) % 12
      if (monthlyByday && DOW[monthlyByday[2]] !== undefined) {
        var ordinal = parseInt(monthlyByday[1], 10)
        if (ordinal === 0 || ordinal > 5 || ordinal < -5) break // not a real ordinal
        var nextByday = nthWeekdayOfMonth(targetYear, targetMonth, DOW[monthlyByday[2]], ordinal, h, mi, se)
        var monthSearch = 0
        // Ordinal doesn't exist in this month (e.g. a "5th" weekday) — skip
        // to the following month instead of falling back to a wrong date.
        while (!nextByday) {
          if (++monthSearch > MAX_MONTH_SEARCH) return results
          targetMonth += interval
          targetYear += Math.floor(targetMonth / 12)
          targetMonth = ((targetMonth % 12) + 12) % 12
          nextByday = nthWeekdayOfMonth(targetYear, targetMonth, DOW[monthlyByday[2]], ordinal, h, mi, se)
        }
        cursor = nextByday
      } else {
        var day = Math.min(start.getDate(), daysInMonth(targetYear, targetMonth))
        cursor = new Date(targetYear, targetMonth, day, h, mi, se, 0)
      }
    } else if (freq === "YEARLY") {
      cursor = new Date(cursor.getFullYear() + interval, cursor.getMonth(), cursor.getDate(), h, mi, se, 0)
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

      var starts = expandRecurrence(master.startMs, master.rrule, exdateSet, rangeStart, horizonMs)
      for (var s = 0; s < starts.length; s++) {
        var startMs = starts[s]
        if (exdateSet[startMs]) continue
        var key = master.uid + "|" + startMs
        var override = overrides[key]
        if (override) {
          if (override.status === "CANCELLED") continue
          occurrences.push({
            startMs: override.startMs, endMs: override.endMs, allDay: override.allDay,
            summary: override.summary, location: override.location, uid: master.uid
          })
        } else {
          occurrences.push({
            startMs: startMs, endMs: startMs + duration, allDay: master.allDay,
            summary: master.summary, location: master.location, uid: master.uid
          })
        }
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
    parseICS: parseICS,
    expandRecurrence: expandRecurrence,
    buildOccurrences: buildOccurrences,
    isSameLocalDay: isSameLocalDay,
    dayLabel: dayLabel,
    timeLabel: timeLabel,
    barLabel: barLabel
  }
}
