import QtQuick
import qs.Commons
import "../model/WindowSwitcherModel.js" as WindowModel

// Flat most-recently-used window grid.
GridView {
  id: view

  required property var metrics
  required property int selectedIndex
  required property bool switcherOpen
  required property string previewMode
  required property int captureLimit
  required property int animationMs

  signal cardHovered(int index)
  signal cardActivated(int index)
  signal cardCloseRequested(int index)

  // Rows hug their cards; the whole block centers vertically when it fits.
  readonly property int rowCount: Math.ceil(Math.max(0, count) / Math.max(1, metrics.columns))

  clip: true
  cellWidth: metrics.cellWidth
  cellHeight: metrics.cellHeight
  topMargin: Math.max(0, Math.floor((height - rowCount * cellHeight) / 2))
  currentIndex: selectedIndex
  boundsBehavior: Flickable.StopAtBounds
  interactive: contentHeight > height
  highlightFollowsCurrentItem: false
  cacheBuffer: height

  delegate: Item {
    id: windowCell

    required property int index
    required property var modelData
    width: view.cellWidth
    height: view.cellHeight

    WindowCard {
      anchors.centerIn: parent
      width: Math.max(1, Math.min(view.metrics.cardWidth, parent.width - Style.spacing.xxl))
      height: Math.max(1, Math.min(view.metrics.cardHeight, parent.height - Style.spacing.xxl))
      windowData: windowCell.modelData
      selected: windowCell.index === view.selectedIndex
      switcherOpen: view.switcherOpen
      captureEnabled: view.switcherOpen && view.previewMode !== WindowModel.PREVIEW_NONE
        && (windowCell.index < view.captureLimit || windowCell.index === view.selectedIndex)
      previewMode: view.previewMode
      animationMs: view.animationMs
      // The flat grid is the most-recently-used order, so the delegate index
      // is the rank. The grouped view sorts by workspace and leaves it unset.
      mruRank: windowCell.index
      onHovered: view.cardHovered(windowCell.index)
      onActivateRequested: view.cardActivated(windowCell.index)
      onCloseRequested: view.cardCloseRequested(windowCell.index)
    }
  }
}
