import QtQuick
import qs.Commons

// Restores every local workspace alias to its generated "Workspace N" label.
// The first click arms the action; the second confirms it. Moving away or
// waiting two seconds disarms it so a stray click cannot erase all aliases.
Rectangle {
  id: button

  required property int nameCount
  property bool armed: false

  signal resetRequested()

  // Reserve both labels so arming the control cannot move it out from under
  // the pointer before the confirming click.
  width: Math.max(label.implicitWidth, confirmMeasure.implicitWidth)
    + Style.spacing.controlPaddingX * 2
  height: Style.spacing.controlHeight
  radius: Style.cornerRadius
  color: button.armed ? Util.alpha(Color.urgent, 0.16) : Style.normalFill
  border.width: button.armed
    ? Math.max(1, Style.selectedBorderWidth)
    : Style.normalBorderWidth
  border.color: button.armed ? Color.urgent : Style.normalBorderColor

  onNameCountChanged: if (nameCount <= 0) armed = false

  Timer {
    id: disarm

    interval: 2000
    onTriggered: button.armed = false
  }

  Text {
    id: label

    anchors.centerIn: parent
    text: button.armed ? "Reset " + button.nameCount + "?" : "Reset names"
    color: button.armed ? Color.urgent : Util.alpha(Color.menu.text, 0.72)
    font.family: Style.font.family
    font.pixelSize: Style.font.caption
    font.weight: button.armed ? Font.DemiBold : Font.Normal
  }

  Text {
    id: confirmMeasure

    visible: false
    text: "Reset " + button.nameCount + "?"
    font.family: Style.font.family
    font.pixelSize: Style.font.caption
    font.weight: Font.DemiBold
  }

  MouseArea {
    id: resetArea

    anchors.fill: parent
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onClicked: function(mouse) {
      mouse.accepted = true
      if (!button.armed) {
        button.armed = true
        disarm.restart()
        return
      }
      button.armed = false
      disarm.stop()
      button.resetRequested()
    }
    onContainsMouseChanged: {
      if (!containsMouse && button.armed) {
        button.armed = false
        disarm.stop()
      }
    }
  }
}
