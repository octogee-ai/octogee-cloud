import QtQuick
import qs.Commons

// Compact close affordance shared by window cards, workspace cards, and
// workspace pills. It rests in neutral chrome and only takes the urgent
// color once the pointer is on it: this switcher's verb is "switch", and a
// row of always-red buttons puts the destructive action at the top of the
// visual hierarchy where the previews belong. With requireConfirm the first
// click only arms the button — it fills red and shows how many windows are
// affected — and a second click within the timeout actually closes; leaving
// the button disarms it.
Rectangle {
  id: button

  property int size: Style.space(22)
  property bool requireConfirm: false
  property int pendingCount: 0
  property bool armed: false

  readonly property bool hot: armed || closeArea.containsMouse

  signal closeRequested()

  width: armed && pendingCount > 0 ? glyph.implicitWidth + Style.spacing.controlPaddingX * 2 : size
  height: size
  radius: Math.min(Style.cornerRadius, height / 2)
  color: hot ? Util.alpha(Color.urgent, 0.95) : Util.alpha(Color.background, 0.72)
  border.width: Math.max(1, Style.spacing.hairline)
  border.color: hot ? Color.urgent : Util.alpha(Color.foreground, 0.28)

  Timer {
    id: disarm

    interval: 2000
    onTriggered: button.armed = false
  }

  Text {
    id: glyph

    anchors.centerIn: parent
    text: button.armed && button.pendingCount > 0 ? "×" + button.pendingCount : "×"
    color: button.hot ? Color.foreground : Util.alpha(Color.foreground, 0.70)
    font.family: Style.font.family
    font.pixelSize: Math.max(10, Math.round(button.size * 0.68))
    font.weight: Font.Bold
  }

  MouseArea {
    id: closeArea

    anchors.fill: parent
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onClicked: function(mouse) {
      mouse.accepted = true
      if (button.requireConfirm && !button.armed) {
        button.armed = true
        disarm.restart()
        return
      }
      button.armed = false
      disarm.stop()
      button.closeRequested()
    }
    onContainsMouseChanged: {
      if (!containsMouse && button.armed) {
        button.armed = false
        disarm.stop()
      }
    }
  }
}
