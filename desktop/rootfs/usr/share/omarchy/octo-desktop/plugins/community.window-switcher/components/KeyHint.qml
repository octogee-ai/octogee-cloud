import QtQuick
import qs.Commons

// One footer legend: the caps for a shortcut followed by the verb it runs.
Row {
  id: hint

  required property var modelData

  spacing: Style.spacing.sm

  Row {
    anchors.verticalCenter: parent.verticalCenter
    spacing: Style.spacing.xxs

    Repeater {
      model: hint.modelData.keys

      delegate: KeyCap {
        required property var modelData
        text: String(modelData)
      }
    }
  }

  Text {
    anchors.verticalCenter: parent.verticalCenter
    text: hint.modelData.label
    color: Util.alpha(Color.menu.text, 0.60)
    font.family: Style.font.family
    font.pixelSize: Style.font.caption
  }
}
