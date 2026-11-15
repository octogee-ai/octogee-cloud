import QtQuick
import qs.Commons
import "../model/WindowSwitcherModel.js" as WindowModel
import "../model/Navigation.js" as Nav

// Window grid split into workspace sections; the model is the group list and
// `windows` is the flat workspace-ordered record list the groups index into.
ListView {
  id: view

  required property var windows
  required property var metrics
  required property int selectedIndex
  required property int focusedWorkspaceId
  required property bool switcherOpen
  required property string previewMode
  required property int captureLimit
  required property int animationMs

  signal cardHovered(int index)
  signal cardActivated(int index)
  signal cardCloseRequested(int index)

  clip: true
  spacing: Style.spacing.lg
  boundsBehavior: Flickable.StopAtBounds
  interactive: contentHeight > height
  cacheBuffer: height

  // Reveal the selected card, not only its workspace section. A section can
  // be taller than the viewport when one workspace contains many windows.
  function reveal(globalIndex) {
    if (globalIndex < 0) return
    var groupIndex = WindowModel.groupIndexFor(model, globalIndex)
    positionViewAtIndex(groupIndex, ListView.Visible)
    Qt.callLater(function() {
      if (view.selectedIndex !== globalIndex) return
      var section = view.itemAtIndex(groupIndex)
      if (section) section.revealGlobalIndex(globalIndex)
    })
  }

  delegate: Column {
    id: groupSection

    required property var modelData
    width: view.width
    spacing: Style.spacing.md

    function revealGlobalIndex(globalIndex) {
      var localIndex = globalIndex - modelData.startIndex
      if (localIndex < 0 || localIndex >= modelData.size) return
      var row = Math.floor(localIndex / Math.max(1, view.metrics.columns))
      var top = cardGrid.mapToItem(
        view.contentItem, 0, row * view.metrics.cellHeight).y
      var minimum = view.originY
      var maximum = Math.max(minimum, view.originY + view.contentHeight - view.height)
      view.contentY = Nav.revealOffset(
        view.contentY, view.height, top, view.metrics.cellHeight, minimum, maximum)
    }

    Item {
      id: groupHeadingRow

      width: parent.width
      height: groupHeading.implicitHeight

      Text {
        id: groupHeading

        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        text: groupSection.modelData.label + " · " + groupSection.modelData.size
        color: Number(groupSection.modelData.id) === view.focusedWorkspaceId
          ? Color.accent : Util.alpha(Color.menu.text, 0.64)
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        font.weight: Font.DemiBold
      }

      Rectangle {
        anchors.left: groupHeading.right
        anchors.leftMargin: Style.spacing.md
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        height: Math.max(1, Style.spacing.hairline)
        color: Util.alpha(Color.menu.border, 0.6)
      }
    }

    Item {
      id: cardGrid

      width: parent.width
      height: Math.ceil(groupSection.modelData.size / view.metrics.columns) * view.metrics.cellHeight

      Repeater {
        model: groupSection.modelData.size

        delegate: Item {
          id: groupCell

          required property int index
          readonly property int globalIndex: groupSection.modelData.startIndex + index
          readonly property var cellWindow: view.windows[globalIndex]
          x: (index % view.metrics.columns) * view.metrics.cellWidth
          y: Math.floor(index / view.metrics.columns) * view.metrics.cellHeight
          width: view.metrics.cellWidth
          height: view.metrics.cellHeight

          WindowCard {
            anchors.centerIn: parent
            width: Math.max(1, Math.min(view.metrics.cardWidth, parent.width - Style.spacing.xxl))
            height: Math.max(1, Math.min(view.metrics.cardHeight, parent.height - Style.spacing.xxl))
            windowData: groupCell.cellWindow
            selected: groupCell.globalIndex === view.selectedIndex
            switcherOpen: view.switcherOpen
            captureEnabled: view.switcherOpen && view.previewMode !== WindowModel.PREVIEW_NONE
              && (groupCell.globalIndex < view.captureLimit || groupCell.globalIndex === view.selectedIndex)
            previewMode: view.previewMode
            animationMs: view.animationMs
            onHovered: view.cardHovered(groupCell.globalIndex)
            onActivateRequested: view.cardActivated(groupCell.globalIndex)
            onCloseRequested: view.cardCloseRequested(groupCell.globalIndex)
          }
        }
      }
    }
  }
}
