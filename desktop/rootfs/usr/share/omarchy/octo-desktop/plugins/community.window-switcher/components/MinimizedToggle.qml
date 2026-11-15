import QtQuick
import qs.Commons

// One-click control for minimized-window visibility in the current opening.
// It belongs with the view controls rather than the filter pills: it selects
// nothing, it changes what the whole list is allowed to contain. The accent
// marks the hidden state only, so a highlight here means the same thing it
// means on a filter pill — a constraint is in force.
Rectangle {
  id: toggle

  required property bool showMinimized

  signal toggleRequested()

  readonly property bool constrained: !toggle.showMinimized

  width: content.implicitWidth + Style.spacing.controlPaddingX * 2
  height: Style.spacing.controlHeight
  radius: Style.cornerRadius
  color: toggle.constrained ? Color.menu.selectedBackground : Style.normalFill
  border.width: toggle.constrained
    ? Math.max(1, Style.selectedBorderWidth)
    : Style.normalBorderWidth
  border.color: toggle.constrained ? Color.accent : Style.normalBorderColor

  Row {
    id: content

    anchors.centerIn: parent
    spacing: Style.spacing.xs

    Text {
      text: "Minimized"
      color: toggle.constrained
        ? Color.menu.selectedText
        : Util.alpha(Color.menu.text, 0.72)
      font.family: Style.font.family
      font.pixelSize: Style.font.caption
      font.weight: toggle.constrained ? Font.DemiBold : Font.Normal
      anchors.verticalCenter: parent.verticalCenter
    }

    Text {
      text: "·"
      color: toggle.constrained
        ? Util.alpha(Color.menu.selectedText, 0.45)
        : Util.alpha(Color.menu.text, 0.35)
      font.family: Style.font.family
      font.pixelSize: Style.font.caption
      anchors.verticalCenter: parent.verticalCenter
    }

    Text {
      text: toggle.showMinimized ? "Shown" : "Hidden"
      color: toggle.constrained
        ? Util.alpha(Color.menu.selectedText, 0.78)
        : Util.alpha(Color.menu.text, 0.58)
      font.family: Style.font.family
      font.pixelSize: Style.font.caption
      anchors.verticalCenter: parent.verticalCenter
    }
  }

  MouseArea {
    anchors.fill: parent
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onClicked: toggle.toggleRequested()
  }
}
