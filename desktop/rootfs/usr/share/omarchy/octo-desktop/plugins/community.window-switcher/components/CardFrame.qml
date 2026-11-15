import QtQuick
import qs.Commons

// Shared selection shell for every window-bearing card. Keeping opacity,
// scale, stacking, ring, and border here makes the two card views hand off
// selection atomically and prevents their visual hierarchy from drifting.
Item {
  id: frame

  required property bool selected
  property Component selectedControl: null
  default property alias contentData: surface.data
  readonly property int contentInset: surface.border.width

  opacity: selected ? 1 : 0.7
  scale: selected ? 1.04 : 1
  z: selected ? 2 : 1

  Rectangle {
    anchors.fill: surface
    anchors.margins: -Style.space(3)
    visible: frame.selected
    radius: surface.radius > 0 ? surface.radius + Style.space(3) : 0
    color: "transparent"
    border.width: Math.max(1, Style.spacing.hairline)
    border.color: Util.alpha(Color.accent, 0.35)
    z: -1
  }

  Rectangle {
    id: surface

    anchors.fill: parent
    color: frame.selected ? Color.menu.selectedBackground : Color.menu.background
    radius: Style.cornerRadius
    border.width: frame.selected ? Math.max(3, Style.spacing.hairline * 3) : Style.spacing.hairline
    border.color: frame.selected ? Color.accent : Color.menu.border
    clip: true
  }

  Loader {
    id: selectedControlLoader

    anchors.top: parent.top
    anchors.right: parent.right
    anchors.margins: Style.spacing.md
    sourceComponent: frame.selectedControl
    visible: frame.selected
    z: 100
  }
}
