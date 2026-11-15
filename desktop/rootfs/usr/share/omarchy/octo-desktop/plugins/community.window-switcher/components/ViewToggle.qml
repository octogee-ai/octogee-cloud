import QtQuick
import qs.Commons
import "../model/WindowSwitcherModel.js" as WindowModel

// Segmented Windows | Workspaces control.
Rectangle {
  id: toggle

  required property string viewMode

  signal windowsRequested()
  signal workspacesRequested()

  readonly property int inset: Math.max(1, Style.normalBorderWidth)

  width: windowsSegment.width + viewDivider.width + workspacesSegment.width + inset * 2
  height: Style.spacing.controlHeight
  radius: Style.cornerRadius
  color: Style.normalFill
  clip: true

  Row {
    anchors.fill: parent
    anchors.margins: toggle.inset

    Rectangle {
      id: windowsSegment

      readonly property bool active: toggle.viewMode !== WindowModel.VIEW_WORKSPACES
      width: Math.ceil(windowsSegmentLabel.implicitWidth) + Style.spacing.controlPaddingX * 2
      height: parent.height
      color: windowsSegment.active ? Color.menu.selectedBackground : "transparent"

      Text {
        id: windowsSegmentLabel

        anchors.centerIn: parent
        text: "Windows"
        color: windowsSegment.active ? Color.menu.selectedText : Util.alpha(Color.menu.text, 0.72)
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
      }

      MouseArea {
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: toggle.windowsRequested()
      }
    }

    Rectangle {
      id: viewDivider

      width: Math.max(1, Style.spacing.hairline)
      height: parent.height
      color: Style.normalBorderColor
    }

    Rectangle {
      id: workspacesSegment

      readonly property bool active: toggle.viewMode === WindowModel.VIEW_WORKSPACES
      width: Math.ceil(workspacesSegmentLabel.implicitWidth) + Style.spacing.controlPaddingX * 2
      height: parent.height
      color: workspacesSegment.active ? Color.menu.selectedBackground : "transparent"

      Text {
        id: workspacesSegmentLabel

        anchors.centerIn: parent
        text: "Workspaces"
        color: workspacesSegment.active ? Color.menu.selectedText : Util.alpha(Color.menu.text, 0.72)
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
      }

      MouseArea {
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: toggle.workspacesRequested()
      }
    }
  }

  Rectangle {
    // The outline paints above the segment fills, so it stays closed on
    // every side regardless of fractional text widths underneath.
    anchors.fill: parent
    color: "transparent"
    radius: toggle.radius
    border.width: Math.max(1, Style.normalBorderWidth)
    border.color: Style.normalBorderColor
    z: 2
  }
}
