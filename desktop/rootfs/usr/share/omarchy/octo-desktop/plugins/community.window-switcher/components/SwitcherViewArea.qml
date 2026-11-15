import QtQuick
import qs.Commons
import "../model/Metrics.js" as Metrics
import "../model/WindowSwitcherModel.js" as WindowModel

// Everything below the header: the three view loaders, the metrics they
// share, and the empty state.
Item {
  id: area

  required property var windows
  required property var groups
  required property string viewMode
  required property int selectedIndex
  required property int focusedWorkspaceId
  required property bool switcherOpen
  required property string previewMode
  required property int captureLimit
  required property var workspaceNames
  required property int animationMs
  required property string query
  required property var activeFilter
  required property int allWindowsCount
  required property int hiddenMinimizedCount
  required property int renamingWorkspaceId

  signal cardHovered(int index)
  signal cardActivated(int index)
  signal cardCloseRequested(int index)
  signal cardCloseAllRequested(int index)
  signal cardRenameRequested(int index)
  signal cardRenameCommitted(int workspaceId, string name)
  signal cardRenameCancelled()
  signal workspaceWindowActivated(int windowIndex)
  signal workspaceWindowCloseRequested(int windowIndex)

  readonly property var flatMetrics: Metrics.compactRows(Metrics.gridMetrics(
    windows.length, width, height,
    Style.spacing.xxl, Style.space(160), 1.6, Style.space(68)), Style.spacing.xxl)
  readonly property var groupMetrics: Metrics.flowMetrics(
    width, Style.spacing.xxl, Style.space(160), 1.6, Style.space(68))
  readonly property var workspaceMetrics: Metrics.compactRows(Metrics.gridMetrics(
    groups.length, width, height,
    Style.spacing.xxl, Style.space(240), 16 / 9, Style.space(68)), Style.spacing.xxl)

  readonly property int flatColumns: flatMetrics.columns
  readonly property int groupColumns: groupMetrics.columns
  readonly property int workspaceColumns: workspaceMetrics.columns

  function reveal(index) {
    if (index < 0) return
    if (viewMode === WindowModel.VIEW_WORKSPACES) {
      if (workspaceLoader.item)
        workspaceLoader.item.positionViewAtIndex(index, GridView.Contain)
    } else if (viewMode === WindowModel.VIEW_GROUPED) {
      if (groupedLoader.item)
        groupedLoader.item.reveal(index)
    } else if (flatLoader.item) {
      flatLoader.item.positionViewAtIndex(index, GridView.Contain)
    }
  }

  Loader {
    id: flatLoader

    anchors.fill: parent
    active: area.viewMode === WindowModel.VIEW_WINDOWS

    sourceComponent: WindowGridView {
      model: area.windows
      metrics: area.flatMetrics
      selectedIndex: area.selectedIndex
      switcherOpen: area.switcherOpen
      previewMode: area.previewMode
      captureLimit: area.captureLimit
      animationMs: area.animationMs
      onCardHovered: function(index) { area.cardHovered(index) }
      onCardActivated: function(index) { area.cardActivated(index) }
      onCardCloseRequested: function(index) { area.cardCloseRequested(index) }
    }
  }

  Loader {
    id: groupedLoader

    anchors.fill: parent
    active: area.viewMode === WindowModel.VIEW_GROUPED

    sourceComponent: GroupedListView {
      model: area.groups
      windows: area.windows
      metrics: area.groupMetrics
      selectedIndex: area.selectedIndex
      focusedWorkspaceId: area.focusedWorkspaceId
      switcherOpen: area.switcherOpen
      previewMode: area.previewMode
      captureLimit: area.captureLimit
      animationMs: area.animationMs
      onCardHovered: function(index) { area.cardHovered(index) }
      onCardActivated: function(index) { area.cardActivated(index) }
      onCardCloseRequested: function(index) { area.cardCloseRequested(index) }
    }
  }

  Loader {
    id: workspaceLoader

    anchors.fill: parent
    active: area.viewMode === WindowModel.VIEW_WORKSPACES

    sourceComponent: WorkspaceGridView {
      model: area.groups
      windows: area.windows
      metrics: area.workspaceMetrics
      selectedIndex: area.selectedIndex
      focusedWorkspaceId: area.focusedWorkspaceId
      switcherOpen: area.switcherOpen
      previewMode: area.previewMode
      captureLimit: area.captureLimit
      workspaceNames: area.workspaceNames
      animationMs: area.animationMs
      renamingWorkspaceId: area.renamingWorkspaceId
      onCardHovered: function(index) { area.cardHovered(index) }
      onCardActivated: function(index) { area.cardActivated(index) }
      onCardCloseAllRequested: function(index) { area.cardCloseAllRequested(index) }
      onCardRenameRequested: function(index) { area.cardRenameRequested(index) }
      onCardRenameCommitted: function(workspaceId, name) { area.cardRenameCommitted(workspaceId, name) }
      onCardRenameCancelled: area.cardRenameCancelled()
      onCardWindowActivated: function(windowIndex) { area.workspaceWindowActivated(windowIndex) }
      onCardWindowCloseRequested: function(windowIndex) { area.workspaceWindowCloseRequested(windowIndex) }
    }
  }

  Column {
    visible: area.windows.length === 0
    anchors.centerIn: parent
    spacing: Style.spacing.md

    Text {
      anchors.horizontalCenter: parent.horizontalCenter
      text: area.allWindowsCount === 0 ? "No windows are open"
        : (area.hiddenMinimizedCount > 0 ? "Minimized windows are hidden" : "No matching windows")
      color: Color.menu.text
      font.family: Style.font.family
      font.pixelSize: Style.font.title
      font.weight: Font.DemiBold
    }

    Text {
      anchors.horizontalCenter: parent.horizontalCenter
      text: {
        if (area.hiddenMinimizedCount > 0) return "Use Ctrl+M or the Minimized control to show them"
        if (area.query) return "Backspace edits the search; Escape clears it"
        if (area.activeFilter.kind === WindowModel.FILTER_WORKSPACE)
          return "Ctrl+A or the All pill shows every window"
        return "Windows appear here as soon as they open"
      }
      color: Util.alpha(Color.menu.text, 0.64)
      font.family: Style.font.family
      font.pixelSize: Style.font.body
    }
  }
}
