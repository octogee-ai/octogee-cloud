import QtQuick
import qs.Commons
import "../model/WindowSwitcherModel.js" as WindowModel

// Segmented Recent | Number control for workspace section order.
Rectangle {
  id: toggle

  required property string workspaceOrder

  signal recentRequested()
  signal numberRequested()

  readonly property int inset: Math.max(1, Style.normalBorderWidth)

  width: recentSegment.width + orderDivider.width + numberSegment.width + inset * 2
  height: Style.spacing.controlHeight
  radius: Style.cornerRadius
  color: Style.normalFill
  clip: true

  Row {
    anchors.fill: parent
    anchors.margins: toggle.inset

    Rectangle {
      id: recentSegment

      readonly property bool active: toggle.workspaceOrder === WindowModel.WORKSPACE_ORDER_RECENT
      width: Math.ceil(recentSegmentLabel.implicitWidth) + Style.spacing.controlPaddingX * 2
      height: parent.height
      color: recentSegment.active ? Color.menu.selectedBackground : "transparent"

      Text {
        id: recentSegmentLabel

        anchors.centerIn: parent
        text: "Recent"
        color: recentSegment.active ? Color.menu.selectedText : Util.alpha(Color.menu.text, 0.72)
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
      }

      MouseArea {
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: toggle.recentRequested()
      }
    }

    Rectangle {
      id: orderDivider

      width: Math.max(1, Style.spacing.hairline)
      height: parent.height
      color: Style.normalBorderColor
    }

    Rectangle {
      id: numberSegment

      readonly property bool active: toggle.workspaceOrder === WindowModel.WORKSPACE_ORDER_NUMBER
      width: Math.ceil(numberSegmentLabel.implicitWidth) + Style.spacing.controlPaddingX * 2
      height: parent.height
      color: numberSegment.active ? Color.menu.selectedBackground : "transparent"

      Text {
        id: numberSegmentLabel

        anchors.centerIn: parent
        text: "Number"
        color: numberSegment.active ? Color.menu.selectedText : Util.alpha(Color.menu.text, 0.72)
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
      }

      MouseArea {
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: toggle.numberRequested()
      }
    }
  }

  Rectangle {
    anchors.fill: parent
    color: "transparent"
    radius: toggle.radius
    border.width: Math.max(1, Style.normalBorderWidth)
    border.color: Style.normalBorderColor
    z: 2
  }
}
