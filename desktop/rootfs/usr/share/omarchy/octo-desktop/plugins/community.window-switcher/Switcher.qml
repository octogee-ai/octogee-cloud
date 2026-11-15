import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Hyprland
import Quickshell.Wayland
import qs.Commons
import "components"
import "model/WindowSwitcherModel.js" as WindowModel
import "model/WindowSnapshot.js" as WindowSnapshot
import "model/Navigation.js" as Nav
import "model/MruOrder.js" as MruOrder

Item {
  id: root

  property var shell: null
  property var manifest: null

  property bool opened: false
  property bool surfaceVisible: false
  property real revealProgress: 0
  property var targetScreen: null
  property var originalToplevel: null
  property var pendingActivation: null
  property var allWindows: []
  property var filteredWindows: []
  property var mruKeys: []
  property int selectedIndex: -1
  property string query: ""
  property var activeFilter: ({ kind: WindowModel.FILTER_ALL })
  property var sessionFilter: null
  property var pillRows: []
  property var windowGroups: []
  property int totalWindowCount: 0
  property int hiddenMinimizedCount: 0
  property int minimizedCount: 0
  property string viewMode: WindowModel.VIEW_WINDOWS
  property string baseViewMode: WindowModel.VIEW_WINDOWS
  property var sessionView: null
  property string workspaceOrder: WindowModel.WORKSPACE_ORDER_RECENT
  property var sessionWorkspaceOrder: null
  property var workspaceNames: ({})
  property bool workspaceNamesDirty: false
  property int renamingWorkspaceId: 0
  readonly property int workspaceNameCount: {
    var count = 0
    for (var workspaceId in workspaceNames) count++
    return count
  }
  property var workspaceMruKeys: []
  property var openWorkspaceMruKeys: []
  property bool stickyFilter: false
  property string previewMode: WindowModel.PREVIEW_STILL
  property string activationMode: WindowModel.ACTIVATION_EXPLICIT
  property bool showMinimized: true
  property bool showSpecialWorkspaces: true
  property int maxInitialCaptures: 20
  property int activeCaptureLimit: 0
  property int animationMs: 140
  property bool modifierReleaseArmed: false
  property int openSerial: 0
  property var openingOverrides: ({})
  property string appliedSettingsKey: ""

  // In workspace view the selection indexes windowGroups and the selected
  // window is that workspace's most recently used one.
  readonly property var selectedWindow: {
    if (viewMode === WindowModel.VIEW_WORKSPACES) {
      var group = selectedIndex >= 0 && selectedIndex < windowGroups.length ? windowGroups[selectedIndex] : null
      return group && group.startIndex < filteredWindows.length ? filteredWindows[group.startIndex] : null
    }
    return selectedIndex >= 0 && selectedIndex < filteredWindows.length ? filteredWindows[selectedIndex] : null
  }
  readonly property int focusedWorkspaceId: Hyprland.focusedWorkspace ? Hyprland.focusedWorkspace.id : 0

  function pluginSettings() {
    if (!shell || !shell.shellConfig || !Array.isArray(shell.shellConfig.plugins)) return {}
    var plugins = shell.shellConfig.plugins
    var id = String(manifest && manifest.id ? manifest.id : "community.window-switcher")
    for (var i = 0; i < plugins.length; i++) {
      if (plugins[i] && String(plugins[i].id || "") === id) return plugins[i]
    }
    return {}
  }

  function currentToplevels() {
    try { return ToplevelManager.toplevels.values || [] } catch (error) { return [] }
  }

  function selectedKey() {
    if (viewMode === WindowModel.VIEW_WORKSPACES) {
      var group = selectedIndex >= 0 && selectedIndex < windowGroups.length ? windowGroups[selectedIndex] : null
      return group ? WindowModel.GROUP_SELECTION_PREFIX + group.key : ""
    }
    return selectedWindow ? selectedWindow.key : ""
  }

  function groupIndexForKey(key) {
    if (!key || String(key).indexOf(WindowModel.GROUP_SELECTION_PREFIX) !== 0) return -1
    var raw = String(key).slice(WindowModel.GROUP_SELECTION_PREFIX.length)
    for (var i = 0; i < windowGroups.length; i++) {
      if (String(windowGroups[i].key) === raw) return i
    }
    return -1
  }

  function workspaceGroupIndexForId(workspaceId) {
    for (var i = 0; i < windowGroups.length; i++) {
      if (Number(windowGroups[i] && windowGroups[i].id) === Number(workspaceId)) return i
    }
    return -1
  }

  function visibleItemCount() {
    return viewMode === WindowModel.VIEW_WORKSPACES ? windowGroups.length : filteredWindows.length
  }

  function indexForKey(values, key) {
    if (!key) return -1
    for (var i = 0; i < values.length; i++) if (values[i] && values[i].key === key) return i
    return -1
  }

  function refreshFiltered(preferredKey, initialDirection) {
    var previousIndex = selectedIndex
    var context = { focusedWorkspaceId: focusedWorkspaceId }
    var visibleAll = WindowModel.filterWindows(
      allWindows, "", { kind: WindowModel.FILTER_ALL }, context, showMinimized,
      showSpecialWorkspaces, workspaceNames)
    totalWindowCount = visibleAll.length
    pillRows = WindowModel.pillRows(visibleAll, context)
    // Counted over every window rather than the filtered set: the toggle is a
    // session control, and it must not flicker in and out while the user types.
    minimizedCount = WindowModel.minimizedCount(allWindows, showSpecialWorkspaces)

    var ordered = WindowModel.filterWindows(
      allWindows,
      query,
      activeFilter,
      context,
      showMinimized,
      showSpecialWorkspaces,
      workspaceNames)
    hiddenMinimizedCount = 0
    if (!showMinimized) {
      var includingMinimized = WindowModel.filterWindows(
        allWindows, query, activeFilter, context, true, showSpecialWorkspaces, workspaceNames)
      for (var hiddenIndex = 0; hiddenIndex < includingMinimized.length; hiddenIndex++) {
        if (WindowModel.isMinimizedWindow(includingMinimized[hiddenIndex])) hiddenMinimizedCount++
      }
    }
    var sectioned = viewMode !== WindowModel.VIEW_WINDOWS
    var next = sectioned
      ? WindowModel.orderByWorkspace(ordered, workspaceOrder, openWorkspaceMruKeys)
      : ordered
    filteredWindows = next
    windowGroups = sectioned ? WindowModel.groupWindows(next, visibleAll, workspaceNames) : []
    if (renamingWorkspaceId > 0 && workspaceGroupIndexForId(renamingWorkspaceId) < 0)
      cancelWorkspaceRename()

    if (viewMode === WindowModel.VIEW_WORKSPACES) {
      if (windowGroups.length === 0) {
        selectedIndex = -1
        return
      }
      var preservedGroup = groupIndexForKey(preferredKey)
      if (preservedGroup >= 0) selectedIndex = preservedGroup
      else if (initialDirection !== undefined) {
        // Alt-Tab semantics per workspace: start on the workspace of the most
        // recent window that is not on the focused workspace.
        var workspaceKey = initialDirection === 0
          ? String(focusedWorkspaceId)
          : WindowModel.previousWorkspaceKey(ordered, focusedWorkspaceId, openWorkspaceMruKeys)
        var initialGroup = groupIndexForKey(WindowModel.GROUP_SELECTION_PREFIX + workspaceKey)
        selectedIndex = initialGroup >= 0 ? initialGroup : 0
      }
      else selectedIndex = Math.max(0, Math.min(previousIndex, windowGroups.length - 1))
      revealSelected()
      return
    }

    if (next.length === 0) {
      selectedIndex = -1
      return
    }

    var preserved = indexForKey(next, preferredKey)
    if (preserved >= 0) selectedIndex = preserved
    else if (initialDirection !== undefined) {
      // Pick the initial window in MRU order even when the display order is
      // grouped, so the first Tab still lands on the previous window.
      var mruIndex = Nav.initialSelection(ordered.length, initialDirection)
      selectedIndex = viewMode === WindowModel.VIEW_GROUPED && mruIndex >= 0
        ? Math.max(0, indexForKey(next, ordered[mruIndex].key))
        : mruIndex
    }
    else if (preferredKey) selectedIndex = Math.max(0, Math.min(previousIndex, next.length - 1))
    else selectedIndex = 0

    revealSelected()
  }

  function rebuildWindows(initialDirection) {
    var preferredKey = selectedKey()
    var toplevels = currentToplevels()
    records.syncObjectKeys(toplevels)
    var entries = records.desktopEntries()
    var rows = []
    for (var i = 0; i < toplevels.length; i++) {
      if (toplevels[i]) rows.push(records.recordFor(toplevels[i], i, entries))
    }

    mruKeys = MruOrder.pruneMru(mruKeys, rows, 200)
    var active = ToplevelManager.activeToplevel
    if (active) {
      for (var j = 0; j < rows.length; j++) {
        if (rows[j].toplevel === active) {
          mruKeys = MruOrder.noteMru(mruKeys, rows[j].key, rows, 200)
          break
        }
      }
    }
    var ordered = MruOrder.orderByMru(rows, mruKeys)
    workspaceMruKeys = WindowModel.completeWorkspaceMru(
      workspaceMruKeys,
      ordered,
      Hyprland.focusedWorkspace ? focusedWorkspaceId : null,
      100)

    // Terminal progress indicators and browsers can change their title many
    // times per second. The snapshot module preserves capture delegates for
    // title-only changes and refreshes all other visible record changes.
    if (opened && initialDirection === undefined) {
      var snapshot = WindowSnapshot.reconcile(allWindows, ordered)
      if (!snapshot.changed) return
      ordered = snapshot.records
    }

    allWindows = ordered
    if (opened) {
      if (initialDirection !== undefined) openWorkspaceMruKeys = workspaceMruKeys.slice()
      refreshFiltered(preferredKey, initialDirection)
    }
  }

  function noteActiveToplevel() {
    var active = ToplevelManager.activeToplevel
    if (!active) return
    var key = ""
    for (var i = 0; i < allWindows.length; i++) {
      var record = allWindows[i]
      if (record.toplevel === active) {
        key = record.key
        break
      }
    }
    if (key) {
      mruKeys = MruOrder.noteMru(mruKeys, key, allWindows, 200)
      root.noteWorkspaceUsed(record.workspaceId)
    }
    modelRefresh.restart()
  }

  function noteWorkspaceUsed(workspaceId) {
    workspaceMruKeys = WindowModel.noteWorkspaceMru(workspaceMruKeys, workspaceId, 100)
  }

  function targetScreenForOpen() {
    var screens = Quickshell.screens || []
    var focused = Hyprland.focusedMonitor
    for (var i = 0; i < screens.length; i++) {
      var monitor = Hyprland.monitorFor(screens[i])
      if (focused && monitor === focused) return screens[i]
      if (focused && monitor && monitor.id === focused.id) return screens[i]
      if (focused && String(screens[i].name || "") === String(focused.name || "")) return screens[i]
    }

    var active = ToplevelManager.activeToplevel
    if (active && active.screens && active.screens.length > 0) return active.screens[0]
    return screens.length > 0 ? screens[0] : null
  }

  function revealSelected() {
    if (!opened || selectedIndex < 0) return
    Qt.callLater(function() {
      if (root.opened && root.selectedIndex >= 0) viewArea.reveal(root.selectedIndex)
    })
  }

  function selectIndex(index) {
    selectedIndex = Nav.wrappedIndex(index, visibleItemCount())
    revealSelected()
  }

  function selectAdjacent(direction) {
    selectedIndex = Nav.moveSequential(selectedIndex, direction, visibleItemCount())
    revealSelected()
  }

  function selectGrid(horizontal, vertical) {
    if (viewMode === WindowModel.VIEW_GROUPED) {
      var sizes = []
      for (var i = 0; i < windowGroups.length; i++) sizes.push(windowGroups[i].size)
      selectedIndex = Nav.moveGrouped(
        selectedIndex, horizontal, vertical, sizes, viewArea.groupColumns)
    } else if (viewMode === WindowModel.VIEW_WORKSPACES) {
      selectedIndex = Nav.moveGrid(
        selectedIndex, horizontal, vertical, windowGroups.length, viewArea.workspaceColumns)
    } else {
      selectedIndex = Nav.moveGrid(
        selectedIndex, horizontal, vertical, filteredWindows.length, viewArea.flatColumns)
    }
    revealSelected()
  }

  function setViewMode(mode) {
    if (WindowModel.VIEW_VALUES.indexOf(mode) < 0 || mode === viewMode) return
    var preferred = ""
    if (mode === WindowModel.VIEW_WORKSPACES) {
      var selected = selectedWindow
      preferred = selected && selected.workspaceId !== undefined && selected.workspaceId !== null
        ? WindowModel.GROUP_SELECTION_PREFIX + String(selected.workspaceId) : ""
    } else if (viewMode === WindowModel.VIEW_WORKSPACES) {
      var group = selectedIndex >= 0 && selectedIndex < windowGroups.length ? windowGroups[selectedIndex] : null
      var front = group && group.startIndex < filteredWindows.length ? filteredWindows[group.startIndex] : null
      preferred = front ? front.key : ""
    } else {
      preferred = selectedKey()
    }
    viewMode = mode
    if (mode !== WindowModel.VIEW_WORKSPACES) baseViewMode = mode
    sessionView = mode
    refreshFiltered(preferred)
  }

  function updateQuery(nextQuery) {
    var preferred = selectedKey()
    query = String(nextQuery || "").slice(0, 128)
    refreshFiltered(preferred)
  }

  function setFilter(filter) {
    var normalized = WindowModel.normalizeFilter(filter) || { kind: WindowModel.FILTER_ALL }
    if (normalized.kind === WindowModel.FILTER_WORKSPACE
        && (normalized.id === undefined || normalized.id === null))
      normalized = { kind: WindowModel.FILTER_WORKSPACE, id: focusedWorkspaceId }
    var preferred = selectedKey()
    activeFilter = normalized
    sessionFilter = normalized
    refreshFiltered(preferred)
  }

  function toggleWorkspaceFilter(workspaceId) {
    if (activeFilter.kind === WindowModel.FILTER_WORKSPACE
        && Number(activeFilter.id) === Number(workspaceId))
      setFilter({ kind: WindowModel.FILTER_ALL })
    else
      setFilter({ kind: WindowModel.FILTER_WORKSPACE, id: workspaceId })
  }

  function toggleMinimizedVisibility() {
    var preferred = selectedKey()
    showMinimized = !showMinimized
    refreshFiltered(preferred)
  }

  function setWorkspaceOrder(order) {
    if (WindowModel.WORKSPACE_ORDER_VALUES.indexOf(order) < 0) return
    var preferred = selectedKey()
    workspaceOrder = order
    sessionWorkspaceOrder = order
    refreshFiltered(preferred)
  }

  function toggleWorkspaceOrder() {
    setWorkspaceOrder(workspaceOrder === WindowModel.WORKSPACE_ORDER_RECENT
      ? WindowModel.WORKSPACE_ORDER_NUMBER
      : WindowModel.WORKSPACE_ORDER_RECENT)
  }

  function beginWorkspaceRename(index) {
    if (viewMode !== WindowModel.VIEW_WORKSPACES
        || index < 0 || index >= windowGroups.length) return
    var group = windowGroups[index]
    var id = Number(group && group.id)
    if (!isFinite(id) || Math.floor(id) !== id || id <= 0) return
    selectIndex(index)
    renamingWorkspaceId = id
  }

  function cancelWorkspaceRename() {
    renamingWorkspaceId = 0
    Qt.callLater(function() { if (root.opened) keySurface.forceActiveFocus() })
  }

  function setWorkspaceName(workspaceId, name) {
    var id = Number(workspaceId)
    if (!isFinite(id) || Math.floor(id) !== id || id <= 0
        || id !== renamingWorkspaceId || workspaceGroupIndexForId(id) < 0) {
      cancelWorkspaceRename()
      return
    }

    var next = {}
    for (var key in workspaceNames) next[key] = workspaceNames[key]
    var candidate = {}
    candidate[String(id)] = name
    var normalized = WindowModel.normalizeWorkspaceNames(candidate)
    if (normalized[String(id)]) next[String(id)] = normalized[String(id)]
    else delete next[String(id)]

    workspaceNames = WindowModel.normalizeWorkspaceNames(next)
    workspaceNamesDirty = true
    renamingWorkspaceId = 0
    // Card labels bind directly to workspaceNames. Rebuilding the group model
    // here would tear down every workspace delegate (and its screencopy
    // resources) just to change one line of text. Search is the only case that
    // needs a refilter because aliases participate in matching.
    if (String(query || "").trim())
      refreshFiltered(WindowModel.GROUP_SELECTION_PREFIX + String(id))
    Qt.callLater(function() { if (root.opened) keySurface.forceActiveFocus() })
  }

  function resetWorkspaceNames() {
    if (workspaceNameCount <= 0) return
    var preferred = selectedKey()
    renamingWorkspaceId = 0
    workspaceNames = WindowModel.normalizeWorkspaceNames({})
    workspaceNamesDirty = true
    // Aliases participate in search, so clearing them can remove matches.
    // Otherwise card labels update directly without rebuilding captures.
    if (String(query || "").trim()) refreshFiltered(preferred)
    Qt.callLater(function() { if (root.opened) keySurface.forceActiveFocus() })
  }

  function beginCaptureRamp() {
    captureRamp.stop()
    activeCaptureLimit = 0
    if (!opened || previewMode === WindowModel.PREVIEW_NONE) return
    captureRamp.start()
  }

  function persistWorkspaceNames() {
    if (!workspaceNamesDirty || !shell || typeof shell.updateEntryInline !== "function") return
    workspaceNamesDirty = false
    var current = pluginSettings()
    var id = String(manifest && manifest.id ? manifest.id : "community.window-switcher")
    var entry = { id: id }
    for (var key in current) if (key !== "id" && key !== "workspaceNames") entry[key] = current[key]
    var hasNames = false
    for (var workspaceId in workspaceNames) {
      hasNames = true
      break
    }
    if (hasNames) entry.workspaceNames = workspaceNames
    shell.updateEntryInline(id, entry)
  }

  function beginClose() {
    if (!surfaceVisible) return
    captureRamp.stop()
    activeCaptureLimit = 0
    renamingWorkspaceId = 0
    opened = false
    modifierReleaseArmed = false
    revealProgress = 0
    closeAnimation.interval = Math.max(1, animationMs)
    closeAnimation.restart()
  }

  function cancel() {
    pendingActivation = originalToplevel
    beginClose()
  }

  function commitSelected() {
    var selected = selectedWindow
    if (!selected || !selected.toplevel) {
      cancel()
      return
    }
    pendingActivation = selected.toplevel
    beginClose()
  }

  // A workspace miniature stands for one window rather than for its card, so
  // the pointer acts on that window instead of on the card's most recent one.
  function activateWindowAt(index) {
    var record = index >= 0 && index < filteredWindows.length ? filteredWindows[index] : null
    if (!record || !record.toplevel) {
      cancel()
      return
    }
    pendingActivation = record.toplevel
    beginClose()
  }

  function closeWindowAt(index) {
    var record = index >= 0 && index < filteredWindows.length ? filteredWindows[index] : null
    if (record && record.toplevel) record.toplevel.close()
  }

  function closeSelectedWindow() {
    // A workspace card stands for many windows; closing from it would be a
    // surprise, so the close shortcut only acts in the window views.
    if (viewMode === WindowModel.VIEW_WORKSPACES) return
    var selected = selectedWindow
    if (selected && selected.toplevel) selected.toplevel.close()
  }

  // Ask every visible window on a workspace to close, regardless of the
  // current search query. These are graceful close requests; applications
  // may prompt to save instead of quitting. A null id targets windows with
  // no workspace association.
  function closeWorkspaceWindows(workspaceId) {
    var none = workspaceId === undefined || workspaceId === null
    for (var i = 0; i < allWindows.length; i++) {
      var record = allWindows[i]
      if (!record || !record.toplevel) continue
      var unassociated = record.workspaceId === undefined || record.workspaceId === null
      if (none ? !unassociated : (unassociated || Number(record.workspaceId) !== Number(workspaceId))) continue
      if (!showMinimized && WindowModel.isMinimizedWindow(record)) continue
      if (!showSpecialWorkspaces && WindowModel.isSpecialWorkspace(record)) continue
      record.toplevel.close()
    }
  }

  function closeWorkspaceGroup(groupIndex) {
    var group = groupIndex >= 0 && groupIndex < windowGroups.length ? windowGroups[groupIndex] : null
    if (!group) return
    closeWorkspaceWindows(group.key === WindowModel.NO_WORKSPACE_KEY ? null : group.id)
  }

  function resolvedFilter(options) {
    var filter = options.filter || { kind: WindowModel.FILTER_ALL }
    if (options.stickyFilter && !options.filterExplicit && sessionFilter) filter = sessionFilter
    if (filter.kind === WindowModel.FILTER_WORKSPACE
        && (filter.id === undefined || filter.id === null))
      filter = { kind: WindowModel.FILTER_WORKSPACE, id: focusedWorkspaceId }
    return filter
  }

  function resolvedView(options) {
    if (!options.viewExplicit && sessionView) return sessionView
    return options.view
  }

  function resolvedWorkspaceOrder(options) {
    if (!options.workspaceOrderExplicit && sessionWorkspaceOrder) return sessionWorkspaceOrder
    return options.workspaceOrder
  }

  function applyOptions(options) {
    previewMode = options.previewMode
    activationMode = options.activation
    showMinimized = options.showMinimized
    showSpecialWorkspaces = options.showSpecialWorkspaces
    maxInitialCaptures = options.maxInitialCaptures
    animationMs = options.animationMs
    viewMode = resolvedView(options)
    workspaceOrder = resolvedWorkspaceOrder(options)
    if (!workspaceNamesDirty) workspaceNames = options.workspaceNames
    baseViewMode = viewMode !== WindowModel.VIEW_WORKSPACES ? viewMode
      : (options.view !== WindowModel.VIEW_WORKSPACES ? options.view : WindowModel.VIEW_WINDOWS)
    stickyFilter = options.stickyFilter
    activeFilter = resolvedFilter(options)
  }

  function open(payloadJson) {
    var payload = WindowModel.parsePayload(payloadJson)
    var settings = pluginSettings()
    var settingsKey = WindowModel.optionApplicationKey(
      WindowModel.effectiveOptions(settings, {}))
    var hasOverrides = WindowModel.hasInvocationOverrides(payload)
    if (!opened || hasOverrides)
      openingOverrides = WindowModel.mergeInvocationOverrides(
        opened ? openingOverrides : {}, payload)
    var invocation = WindowModel.mergeInvocationOverrides(openingOverrides, {})
    invocation.direction = payload.direction
    var options = WindowModel.effectiveOptions(settings, invocation)

    if (opened
        && !hasOverrides
        && settingsKey === appliedSettingsKey) {
      if (options.direction !== 0) selectAdjacent(options.direction)
      focusDelay.restart()
      return
    }

    if (opened) {
      var previousPreviewMode = previewMode
      var previousMaxInitialCaptures = maxInitialCaptures
      applyOptions(options)
      appliedSettingsKey = settingsKey
      if (previewMode !== previousPreviewMode
          || maxInitialCaptures !== previousMaxInitialCaptures) beginCaptureRamp()
      if (payload.query !== undefined) updateQuery(options.query)
      else refreshFiltered(selectedKey())
      if (options.direction !== 0) selectAdjacent(options.direction)
      focusDelay.restart()
      return
    }

    openSerial++
    closeAnimation.stop()
    applyOptions(options)
    appliedSettingsKey = settingsKey
    query = options.query
    if (shell && shell.appLibrary && typeof shell.appLibrary.refreshIcons === "function")
      shell.appLibrary.refreshIcons()
    originalToplevel = ToplevelManager.activeToplevel
    pendingActivation = null
    targetScreen = targetScreenForOpen()
    surfaceVisible = true
    opened = true
    captureRamp.stop()
    activeCaptureLimit = 0
    modifierReleaseArmed = false
    revealProgress = 0
    // Window geometry and focus history come from Hyprland's IPC snapshot,
    // which Quickshell only updates on request; ask for fresh data and pick
    // it up with a follow-up rebuild once the roundtrip has settled.
    Hyprland.refreshToplevels()
    Hyprland.refreshMonitors()
    geometrySettle.restart()
    rebuildWindows(options.direction)
    Qt.callLater(function() { if (root.opened) root.revealProgress = 1 })
    focusDelay.restart()
  }

  function close() {
    cancel()
  }

  function ping() {
    return "ok"
  }

  function status() {
    return JSON.stringify({
      opened: opened,
      surfaceVisible: surfaceVisible,
      windowCount: allWindows.length,
      filteredCount: filteredWindows.length,
      selectedIndex: selectedIndex,
      selectedKey: selectedWindow ? selectedWindow.key : "",
      selectedTitle: selectedWindow ? selectedWindow.title : "",
      selectedAddress: selectedWindow ? selectedWindow.address : "",
      filter: activeFilter,
      view: viewMode,
      workspaceOrder: workspaceOrder,
      workspaceNames: workspaceNames,
      workspaceCount: windowGroups.length,
      workspaceKeys: windowGroups.map(function(group) { return group.key }),
      workspaceHistory: openWorkspaceMruKeys,
      previewMode: previewMode,
      showMinimized: showMinimized,
      hiddenMinimizedCount: hiddenMinimizedCount,
      minimizedCount: minimizedCount,
      maxInitialCaptures: maxInitialCaptures,
      activeCaptureLimit: activeCaptureLimit,
      targetScreen: targetScreen ? String(targetScreen.name || "") : ""
    })
  }

  WindowRecords {
    id: records

    shell: root.shell
  }

  CompositorSignals {
    switcherOpen: root.opened
    onRefreshRequested: modelRefresh.restart()
    onGeometryRefreshRequested: geometrySettle.restart()
    onActiveWindowChanged: root.noteActiveToplevel()
    onWorkspaceFocusChanged: function(workspaceId) { root.noteWorkspaceUsed(workspaceId) }
    onScreenLayoutChanged: {
      if (root.opened) root.targetScreen = root.targetScreenForOpen()
      modelRefresh.restart()
    }
  }

  Timer {
    id: focusDelay

    interval: 1
    onTriggered: {
      if (!root.opened) return
      keySurface.forceActiveFocus()
      root.modifierReleaseArmed = true
    }
  }

  Timer {
    id: closeAnimation

    interval: 140
    onTriggered: {
      if (root.opened) return
      var target = root.pendingActivation
      var serial = root.openSerial
      root.surfaceVisible = false
      root.filteredWindows = []
      root.windowGroups = []
      root.query = ""
      root.originalToplevel = null
      root.pendingActivation = null
      root.targetScreen = null
      Qt.callLater(function() {
        if (serial === root.openSerial && !root.opened && target) target.activate()
        if (serial === root.openSerial && !root.opened) root.persistWorkspaceNames()
      })
    }
  }

  Timer {
    id: modelRefresh

    interval: 24
    onTriggered: root.rebuildWindows()
  }

  Timer {
    id: geometrySettle

    interval: 160
    onTriggered: {
      root.rebuildWindows()
      if (root.activeCaptureLimit === 0) root.beginCaptureRamp()
    }
  }

  // Creating a full set of screencopy sources in one frame can allocate
  // hundreds of megabytes and visibly stall the shell. Wait for the initial
  // compositor geometry roundtrip, then attach a few sources per frame.
  Timer {
    id: captureRamp

    interval: 40
    repeat: true
    onTriggered: {
      if (!root.opened || root.previewMode === WindowModel.PREVIEW_NONE) {
        stop()
        root.activeCaptureLimit = 0
        return
      }
      root.activeCaptureLimit = Math.min(root.maxInitialCaptures, root.activeCaptureLimit + 2)
      if (root.activeCaptureLimit >= root.maxInitialCaptures) stop()
    }
  }

  Component.onCompleted: rebuildWindows()

  PanelWindow {
    id: panel

    screen: root.targetScreen
    visible: root.surfaceVisible
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    exclusionMode: ExclusionMode.Ignore
    WlrLayershell.namespace: "omarchy-window-switcher"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: root.opened ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None
    mask: Region {
      width: root.opened ? panel.width : 0
      height: root.opened ? panel.height : 0
    }

    Rectangle {
      anchors.fill: parent
      color: Color.menu.scrim
      opacity: root.revealProgress

      Behavior on opacity {
        NumberAnimation { duration: root.animationMs; easing.type: Easing.OutCubic }
      }
    }

    MouseArea {
      anchors.fill: parent
      enabled: root.opened
      onClicked: root.cancel()
    }

    SwitcherKeySurface {
      id: keySurface

      anchors.fill: parent
      query: root.query
      activationMode: root.activationMode
      releaseArmed: root.modifierReleaseArmed
      editingWorkspaceName: root.renamingWorkspaceId > 0
      onEscapePressed: {
        if (root.query) root.updateQuery("")
        else if (root.activeFilter.kind !== WindowModel.FILTER_ALL)
          root.setFilter({ kind: WindowModel.FILTER_ALL })
        else root.cancel()
      }
      onCommitRequested: root.commitSelected()
      onStepRequested: function(direction) { root.selectAdjacent(direction) }
      onGridMoveRequested: function(horizontal, vertical) { root.selectGrid(horizontal, vertical) }
      onAllFilterRequested: root.setFilter({ kind: WindowModel.FILTER_ALL })
      onMinimizedToggleRequested: root.toggleMinimizedVisibility()
      onWorkspaceOrderToggleRequested: root.toggleWorkspaceOrder()
      onWorkspaceRenameRequested: root.beginWorkspaceRename(root.selectedIndex)
      onViewToggleRequested: root.setViewMode(root.viewMode === WindowModel.VIEW_WORKSPACES
        ? root.baseViewMode : WindowModel.VIEW_WORKSPACES)
      onGroupToggleRequested: root.setViewMode(root.viewMode === WindowModel.VIEW_GROUPED
        ? WindowModel.VIEW_WINDOWS : WindowModel.VIEW_GROUPED)
      onWorkspaceDigitPressed: function(workspaceId) { root.toggleWorkspaceFilter(workspaceId) }
      onCloseWindowRequested: root.closeSelectedWindow()
      onQueryEdited: function(nextQuery) { root.updateQuery(nextQuery) }
      onModifierReleased: root.commitSelected()

      Rectangle {
        id: switcherCard

        width: Math.max(360, Math.min(parent.width - Style.space(40), parent.width * 0.88))
        height: Math.max(300, Math.min(parent.height - Style.space(40), parent.height * 0.84))
        anchors.centerIn: parent
        color: Color.menu.background
        radius: Style.cornerRadius
        border.width: Math.max(1, Style.spacing.hairline)
        border.color: Color.menu.border
        opacity: root.revealProgress
        scale: 0.97 + 0.03 * root.revealProgress

        Behavior on opacity {
          NumberAnimation { duration: root.animationMs; easing.type: Easing.OutCubic }
        }
        Behavior on scale {
          NumberAnimation { duration: root.animationMs; easing.type: Easing.OutCubic }
        }

        MouseArea {
          anchors.fill: parent
          onClicked: function(mouse) { mouse.accepted = true }
        }

        ColumnLayout {
          anchors.fill: parent
          anchors.margins: Style.spacing.panelPadding
          spacing: Style.spacing.panelGap

          SwitcherHeader {
            Layout.fillWidth: true
            pillRows: root.pillRows
            activeFilter: root.activeFilter
            showMinimized: root.showMinimized
            minimizedCount: root.minimizedCount
            viewMode: root.viewMode
            workspaceOrder: root.workspaceOrder
            workspaceNameCount: root.workspaceNameCount
            query: root.query
            switcherOpen: root.opened
            countText: WindowModel.viewCountLabel(
              root.viewMode,
              root.windowGroups.length,
              root.filteredWindows.length,
              root.totalWindowCount,
              root.activeFilter,
              root.query,
              WindowModel.filterLabel(root.activeFilter, root.allWindows))
            onAllPicked: root.setFilter({ kind: WindowModel.FILTER_ALL })
            onQueryCleared: root.updateQuery("")
            onMinimizedToggleRequested: root.toggleMinimizedVisibility()
            onWorkspaceOrderRequested: function(order) { root.setWorkspaceOrder(order) }
            onWorkspaceNamesResetRequested: root.resetWorkspaceNames()
            onWorkspaceToggled: function(workspaceId) { root.toggleWorkspaceFilter(workspaceId) }
            onWorkspaceCloseRequested: function(workspaceId) { root.closeWorkspaceWindows(workspaceId) }
            onWindowsViewRequested: root.setViewMode(root.baseViewMode)
            onWorkspacesViewRequested: root.setViewMode(WindowModel.VIEW_WORKSPACES)
          }

          SwitcherViewArea {
            id: viewArea

            Layout.fillWidth: true
            Layout.fillHeight: true
            windows: root.filteredWindows
            groups: root.windowGroups
            viewMode: root.viewMode
            selectedIndex: root.selectedIndex
            focusedWorkspaceId: root.focusedWorkspaceId
            switcherOpen: root.opened
            previewMode: root.previewMode
            captureLimit: root.activeCaptureLimit
            workspaceNames: root.workspaceNames
            animationMs: root.animationMs
            query: root.query
            activeFilter: root.activeFilter
            allWindowsCount: root.allWindows.length
            hiddenMinimizedCount: root.hiddenMinimizedCount
            onCardHovered: function(index) { root.selectIndex(index) }
            onCardActivated: function(index) {
              root.selectIndex(index)
              root.commitSelected()
            }
            onCardCloseRequested: function(index) {
              root.selectIndex(index)
              root.closeSelectedWindow()
            }
            onCardCloseAllRequested: function(index) { root.closeWorkspaceGroup(index) }
            renamingWorkspaceId: root.renamingWorkspaceId
            onCardRenameRequested: function(index) { root.beginWorkspaceRename(index) }
            onCardRenameCommitted: function(workspaceId, name) { root.setWorkspaceName(workspaceId, name) }
            onCardRenameCancelled: root.cancelWorkspaceRename()
            onWorkspaceWindowActivated: function(windowIndex) { root.activateWindowAt(windowIndex) }
            onWorkspaceWindowCloseRequested: function(windowIndex) { root.closeWindowAt(windowIndex) }
          }

          FooterHints {
            Layout.fillWidth: true
            activationMode: root.activationMode
            previewMode: root.previewMode
            viewMode: root.viewMode
            minimizedCount: root.minimizedCount
          }
        }
      }
    }
  }
}
