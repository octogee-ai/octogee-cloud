import QtQuick
import qs.Commons

// One key legend drawn as a cap. Border-only on purpose: in this kit an
// outlined chip means "a key you can press" and a filled chip means "a
// count", so the two can never be read as the same thing.
Rectangle {
  id: cap

  property string text: ""
  property color textColor: Util.alpha(Color.menu.text, 0.82)

  implicitHeight: capLabel.implicitHeight + Style.spacing.xxs * 2
  implicitWidth: Math.max(implicitHeight, capLabel.implicitWidth + Style.spacing.sm * 2)
  width: implicitWidth
  height: implicitHeight
  radius: Math.min(Style.cornerRadius, Math.round(height / 3))
  color: Util.alpha(Color.foreground, 0.06)
  border.width: Math.max(1, Style.spacing.hairline)
  border.color: Util.alpha(Color.foreground, 0.30)

  Text {
    id: capLabel

    anchors.centerIn: parent
    text: cap.text
    color: cap.textColor
    font.family: Style.font.family
    font.pixelSize: Style.font.caption
    font.weight: Font.DemiBold
  }
}
