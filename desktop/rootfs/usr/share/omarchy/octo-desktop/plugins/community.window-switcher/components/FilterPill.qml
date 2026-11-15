import QtQuick
import qs.Commons
import "../model/WindowSwitcherModel.js" as WindowModel

// One entry of the filter row: the All pill, a workspace pill with its
// window count, or (multi-monitor only) a monitor rule that divides the row.
//
// The pill has one job the eye must never get wrong: tell the workspace from
// its window count. Two text runs beside each other read as one number, so
// the number wears a key cap and the count wears a filled chip — the same
// grammar the footer legends use, which also makes Ctrl+1…9 self-evident on
// every workspace that has the shortcut.
Rectangle {
  id: pill

  required property var modelData
  required property var activeFilter

  signal allPicked()
  signal workspaceToggled(var workspaceId)
  signal closeAllRequested(var workspaceId)

  readonly property bool isLabel: modelData.type === WindowModel.PILL_LABEL
  readonly property bool active: modelData.type === WindowModel.PILL_ALL
    ? activeFilter.kind === WindowModel.FILTER_ALL
    : modelData.type === WindowModel.PILL_WORKSPACE
      && activeFilter.kind === WindowModel.FILTER_WORKSPACE
      && Number(activeFilter.id) === Number(modelData.id)
  // Numbered workspaces wear the digit that actually selects them. Workspace
  // 10 therefore shows 0, matching Ctrl+0, rather than pretending Ctrl+10 is a
  // key chord the switcher can receive.
  readonly property string shortcutKey: modelData.type === WindowModel.PILL_WORKSPACE
    ? WindowModel.workspaceShortcutKey(modelData.id, modelData.label) : ""
  readonly property bool capped: shortcutKey.length > 0
  readonly property color labelColor: isLabel ? Util.alpha(Color.menu.text, 0.62)
    : active ? Color.menu.selectedText : Color.menu.text

  width: pillContent.implicitWidth + (isLabel ? 0 : Style.spacing.controlPaddingX * 2)
  height: Style.spacing.controlHeight
  radius: Math.min(Style.cornerRadius, height / 2)
  color: isLabel ? "transparent" : (active ? Color.menu.selectedBackground : Style.normalFill)
  border.width: isLabel ? 0 : (active ? Math.max(1, Style.selectedBorderWidth) : Style.normalBorderWidth)
  border.color: active ? Color.accent : Style.normalBorderColor

  Row {
    id: pillContent

    // Raised above the pill's own MouseArea sibling so the close button can
    // take its clicks; text does not grab mouse, so pill clicks still work.
    z: 1
    anchors.centerIn: parent
    spacing: Style.spacing.xs

    Rectangle {
      // Monitor rows are dividers, not controls. A rule ahead of the name
      // makes the grouping visible without adding another pill-shaped thing
      // the eye has to test for clickability.
      visible: pill.isLabel
      width: Math.max(1, Style.spacing.hairline)
      height: Math.round(pill.height * 0.5)
      color: Util.alpha(Color.menu.text, 0.35)
      anchors.verticalCenter: parent.verticalCenter
    }

    Rectangle {
      visible: pill.modelData.focused === true
      width: Style.space(6)
      height: width
      radius: width / 2
      color: Color.accent
      anchors.verticalCenter: parent.verticalCenter
    }

    Rectangle {
      // A workspace holding an urgent window flags it from anywhere.
      visible: pill.modelData.urgent === true
      width: Style.space(6)
      height: width
      radius: width / 2
      color: Color.urgent
      anchors.verticalCenter: parent.verticalCenter
    }

    KeyCap {
      visible: pill.capped
      text: pill.shortcutKey
      textColor: pill.labelColor
      border.color: pill.active ? Util.alpha(Color.accent, 0.75) : Util.alpha(Color.foreground, 0.30)
      anchors.verticalCenter: parent.verticalCenter
    }

    Text {
      visible: !pill.capped
      text: pill.modelData.label
      color: pill.labelColor
      font.family: Style.font.family
      font.pixelSize: pill.isLabel ? Style.font.caption : Style.font.title
      font.weight: pill.isLabel ? Font.DemiBold : Font.Bold
      anchors.verticalCenter: parent.verticalCenter
    }

    // The count lives in a filled chip so it can never be read as another
    // digit of the workspace number beside it.
    Rectangle {
      id: countChip

      visible: pill.modelData.count !== undefined
      width: Math.max(height, countLabel.implicitWidth + Style.spacing.sm * 2)
      height: Style.space(15)
      radius: height / 2
      color: pill.active ? Util.alpha(Color.menu.selectedText, 0.20) : Util.alpha(Color.foreground, 0.13)
      anchors.verticalCenter: parent.verticalCenter

      Text {
        id: countLabel

        anchors.centerIn: parent
        text: pill.modelData.count !== undefined ? String(pill.modelData.count) : ""
        color: pill.active ? Color.menu.selectedText : Util.alpha(Color.menu.text, 0.78)
        font.family: Style.font.family
        font.pixelSize: Math.max(8, Style.font.caption - 1)
        font.weight: Font.DemiBold
      }
    }

    // Kept in the layout at all times and only faded in under the pointer: a
    // control that appears out of nothing would reflow every pill to its right
    // the moment the mouse crossed the row.
    CloseButton {
      id: pillClose

      visible: pill.modelData.type === WindowModel.PILL_WORKSPACE
      // The pointer moving onto the button takes hover away from the pill's
      // own area, so the button's hot state has to hold the reveal open.
      opacity: pillArea.containsMouse || pillClose.hot ? 1 : 0
      enabled: pillArea.containsMouse || pillClose.hot
      size: Style.space(18)
      requireConfirm: true
      pendingCount: pill.modelData.count !== undefined ? pill.modelData.count : 0
      anchors.verticalCenter: parent.verticalCenter
      onCloseRequested: pill.closeAllRequested(pill.modelData.id)

      Behavior on opacity {
        NumberAnimation { duration: 90 }
      }
    }
  }

  MouseArea {
    id: pillArea

    anchors.fill: parent
    enabled: !pill.isLabel
    hoverEnabled: true
    cursorShape: pill.isLabel ? Qt.ArrowCursor : Qt.PointingHandCursor
    onClicked: {
      if (pill.modelData.type === WindowModel.PILL_ALL) pill.allPicked()
      else pill.workspaceToggled(pill.modelData.id)
    }
  }
}
