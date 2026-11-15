import QtQuick
import qs.Commons

// Shared pill-shaped badge for card overlays: workspace chip, state badge,
// and the "Current" workspace marker all use this one shape so their styling
// cannot drift apart.
Rectangle {
  id: badge

  property string text: ""
  property bool outlined: false
  property color fillColor: Util.alpha(Color.background, 0.84)

  height: Style.space(22)
  width: badgeLabel.implicitWidth + Style.spacing.controlPaddingX * 2
  radius: Math.min(Style.cornerRadius, height / 2)
  color: fillColor
  border.width: outlined ? Math.max(1, Style.spacing.hairline) : 0
  border.color: Util.alpha(Color.accent, 0.55)

  Text {
    id: badgeLabel

    anchors.centerIn: parent
    text: badge.text
    color: Color.foreground
    font.family: Style.font.family
    font.pixelSize: Style.font.caption
  }
}
