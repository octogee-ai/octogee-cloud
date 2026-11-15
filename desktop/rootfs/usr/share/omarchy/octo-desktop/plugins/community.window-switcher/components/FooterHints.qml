import QtQuick
import QtQuick.Layouts
import qs.Commons
import "../model/WindowSwitcherModel.js" as WindowModel

// Bottom hint row: the keymap drawn as caps rather than a run-on sentence,
// split into the three keys that always apply and the view's own controls.
// The secondary group yields the row when the card is too narrow for both,
// because a clipped legend teaches nothing.
RowLayout {
  id: footer

  required property string activationMode
  required property string previewMode
  required property string viewMode
  required property int minimizedCount

  readonly property var hints: WindowModel.footerHints(viewMode, activationMode, minimizedCount)

  spacing: Style.spacing.xxl

  Row {
    id: primaryHints

    Layout.alignment: Qt.AlignVCenter
    spacing: Style.spacing.xl

    Repeater {
      model: footer.hints.primary

      delegate: KeyHint {}
    }
  }

  Item {
    Layout.fillWidth: true
    Layout.preferredHeight: 1
  }

  Item {
    // The row inside stays visible so its implicit width keeps reporting what
    // the group needs; only this wrapper leaves the layout. Measuring a row
    // that has hidden itself would let the two states chase each other.
    id: secondarySlot

    Layout.alignment: Qt.AlignVCenter
    implicitWidth: secondaryHints.implicitWidth
    implicitHeight: secondaryHints.implicitHeight
    visible: footer.width >= primaryHints.implicitWidth + secondaryHints.implicitWidth
      + previewLabel.implicitWidth + Style.spacing.xxl * 3

    Row {
      id: secondaryHints

      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.spacing.xl

      Repeater {
        model: footer.hints.secondary

        delegate: KeyHint {}
      }
    }
  }

  Text {
    id: previewLabel

    Layout.alignment: Qt.AlignVCenter
    text: footer.previewMode === WindowModel.PREVIEW_NONE
      ? "Previews off"
      : (footer.previewMode === WindowModel.PREVIEW_LIVE_SELECTED
        ? "Selected preview live" : "Still previews")
    color: Util.alpha(Color.menu.text, 0.45)
    font.family: Style.font.family
    font.pixelSize: Style.font.caption
  }
}
