import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import qs.Ui
import qs.Commons
import "Model.js" as Model

// Calendar popup: fetches the published .ics feed on a
// timer and shows upcoming events grouped by day. See Model.js for the
// (deliberately partial) iCalendar parsing this relies on.
Panel {
  id: root
  moduleName: "mrmoe.ics-calendar"
  ipcTarget: "mrmoe.ics-calendar"

  property var anchorItem: null
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  readonly property int refreshIntervalMs: 10 * 60 * 1000
  readonly property int horizonDays: 7
  readonly property int minRefetchGapMs: 60 * 1000

  property string icsUrl: ""
  property var events: []
  // Millisecond epoch timestamps overflow QML's 32-bit "int", so these are
  // "real" (double) rather than "int" — that overflow was the reason a
  // fully-populated events list produced zero occurrences during testing.
  property real lastFetchMs: 0
  property bool fetching: false
  property bool lastFetchFailed: false
  property real nowMs: Date.now()

  readonly property var occurrences: Model.buildOccurrences(root.events, root.nowMs, root.nowMs + root.horizonDays * 86400000)
  // Kept short: the bar renders this as a real text label sized to its
  // content (see BarWidget.qml), and a very long meeting title would crowd
  // neighboring widgets. The untruncated version goes in the tooltip.
  readonly property string label: Model.barLabel(root.occurrences, root.nowMs, 22)
  readonly property string fullLabel: Model.barLabel(root.occurrences, root.nowMs, 200)

  // Flattened for the ListView: a day-header row ahead of each day's first
  // event, exactly like the bar's own section-header rows elsewhere.
  readonly property var rows: {
    var out = []
    var lastDay = ""
    for (var i = 0; i < root.occurrences.length; i++) {
      var o = root.occurrences[i]
      var day = Model.dayLabel(o.startMs, root.nowMs)
      if (day !== lastDay) {
        out.push({ isHeader: true, label: day })
        lastDay = day
      }
      out.push({ isHeader: false, occurrence: o })
    }
    return out
  }

  function injectPanel() {}

  function open() {
    root.controller.show()
    root.maybeRefresh()
  }

  function close() {
    root.controller.hide()
  }

  function toggle() {
    if (root.opened) root.close()
    else root.open()
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  function maybeRefresh() {
    if (root.events.length === 0 || (root.nowMs - root.lastFetchMs) > root.minRefetchGapMs) root.refresh()
  }

  function refresh() {
    if (root.fetching || root.icsUrl === "") return
    root.fetching = true
    icsProc.command = ["curl", "-fsS", "--max-time", "10", root.icsUrl]
    icsProc.running = true
  }

  FileView {
    id: urlFile
    path: Quickshell.env("HOME") + "/.local/state/omarchy/settings/ics-calendar.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.applyUrlFile(text())
    onLoadFailed: root.icsUrl = ""
  }

  function applyUrlFile(raw) {
    try {
      var data = JSON.parse(String(raw || "{}"))
      var next = typeof data.icsUrl === "string" ? data.icsUrl.trim() : ""
      var changed = next !== root.icsUrl
      root.icsUrl = next
      if (changed) root.refresh()
    } catch (e) {
      root.icsUrl = ""
    }
  }

  Process {
    id: icsProc
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        root.fetching = false
        var raw = String(text || "")
        if (raw.trim() === "") {
          root.lastFetchFailed = true
          return
        }
        try {
          root.events = Model.parseICS(raw)
          root.lastFetchMs = Date.now()
          root.lastFetchFailed = false
        } catch (e) {
          root.lastFetchFailed = true
        }
      }
    }
  }

  Timer {
    interval: root.refreshIntervalMs
    running: true
    repeat: true
    onTriggered: root.refresh()
  }

  Timer {
    interval: 30000
    running: true
    repeat: true
    onTriggered: root.nowMs = Date.now()
  }

  Component.onCompleted: Qt.callLater(root.maybeRefresh)

  visible: true
  implicitWidth: 1
  implicitHeight: 1

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(360))
    contentHeight: panel.fittedContentHeight(column.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Column {
        id: column
        anchors.fill: parent
        spacing: Style.space(12)

        Item {
          width: parent.width
          implicitHeight: heroTitle.implicitHeight

          Text {
            id: heroTitle
            textFormat: Text.PlainText
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            text: "ICS Calendar"
            color: root.bar.foreground
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.title
            font.bold: true
          }

          Text {
            id: refreshLink
            textFormat: Text.PlainText
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            text: root.fetching ? "Refreshing…" : "Refresh"
            color: refreshMouse.containsMouse ? Color.accent : Qt.darker(root.bar.foreground, 1.4)
            font.family: root.bar.fontFamily
            font.pixelSize: Style.font.caption

            MouseArea {
              id: refreshMouse
              anchors.fill: parent
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: root.refresh()
            }
          }
        }

        Text {
          textFormat: Text.PlainText
          visible: root.icsUrl === ""
          width: parent.width
          wrapMode: Text.WordWrap
          text: "No calendar URL configured.\n\nIn Outlook on the web: Settings → Calendar → Shared calendars → Publish a calendar, then copy the ICS link.\n\nPaste it as \"icsUrl\" in ~/.local/state/omarchy/settings/ics-calendar.json (or re-run install.sh after deleting that file)."
          color: Qt.darker(root.bar.foreground, 1.4)
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.bodySmall
        }

        Text {
          textFormat: Text.PlainText
          visible: root.icsUrl !== "" && root.lastFetchFailed && root.events.length === 0
          width: parent.width
          wrapMode: Text.WordWrap
          text: "Couldn't reach the calendar feed. Will keep retrying."
          color: Qt.darker(root.bar.foreground, 1.4)
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.bodySmall
        }

        PanelSeparator {
          visible: root.rows.length > 0
          foreground: root.bar.foreground
        }

        ListView {
          id: eventList
          width: parent.width
          height: Math.min(contentHeight, Style.space(420))
          spacing: Style.space(6)
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          interactive: contentHeight > height
          visible: root.rows.length > 0

          ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

          model: root.rows

          delegate: Item {
            required property var modelData
            width: ListView.view.width
            implicitHeight: modelData.isHeader ? headerText.implicitHeight + Style.space(8) : eventRow.implicitHeight

            PanelSectionHeader {
              id: headerText
              visible: modelData.isHeader
              anchors.top: parent.top
              anchors.topMargin: Style.space(6)
              text: modelData.isHeader ? modelData.label : ""
              foreground: root.bar.foreground
              fontFamily: root.bar.fontFamily
            }

            Column {
              id: eventRow
              visible: !modelData.isHeader
              width: parent.width
              spacing: Style.space(1)

              Text {
                textFormat: Text.PlainText
                text: modelData.isHeader ? "" : modelData.occurrence.summary
                color: root.bar.foreground
                font.family: root.bar.fontFamily
                font.pixelSize: Style.font.body
                elide: Text.ElideRight
                width: parent.width
              }
              Text {
                textFormat: Text.PlainText
                text: modelData.isHeader ? "" : Model.timeLabel(modelData.occurrence)
                color: Qt.darker(root.bar.foreground, 1.4)
                font.family: root.bar.fontFamily
                font.pixelSize: Style.font.caption
                elide: Text.ElideRight
                width: parent.width
              }
            }
          }
        }

        Text {
          textFormat: Text.PlainText
          visible: root.icsUrl !== "" && root.rows.length === 0 && !root.lastFetchFailed
          text: "No events in the next " + root.horizonDays + " days"
          color: Qt.darker(root.bar.foreground, 1.5)
          font.family: root.bar.fontFamily
          font.pixelSize: Style.font.bodySmall
        }
      }
    }
  }
}
