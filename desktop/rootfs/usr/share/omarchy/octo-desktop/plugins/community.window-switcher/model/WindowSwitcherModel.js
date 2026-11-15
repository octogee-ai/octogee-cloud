// Core switcher model: option parsing, filtering, workspace semantics, pills,
// counts, and workspace-card layout. Sibling modules carry the standalone
// clusters: EntryMatching.js, Navigation.js, Metrics.js, MruOrder.js. Every
// model file is loaded both by QML and by the Node test harness, so none of
// them may depend on another.

// Shared domain values. Keep these names at the model boundary so QML callers
// do not duplicate the serialized values used by settings, payloads, and view
// models.
var FILTER_ALL = "all"
var FILTER_WORKSPACE = "workspace"
var LEGACY_FILTER_MONITOR = "monitor"
var LEGACY_FILTER_CURRENT = "current"

var VIEW_WINDOWS = "windows"
var VIEW_GROUPED = "grouped"
var VIEW_WORKSPACES = "workspaces"
var VIEW_VALUES = [VIEW_WINDOWS, VIEW_GROUPED, VIEW_WORKSPACES]

var WORKSPACE_ORDER_RECENT = "recent"
var WORKSPACE_ORDER_NUMBER = "number"
var WORKSPACE_ORDER_VALUES = [WORKSPACE_ORDER_RECENT, WORKSPACE_ORDER_NUMBER]

var PREVIEW_NONE = "none"
var PREVIEW_STILL = "still"
var PREVIEW_LIVE_SELECTED = "liveSelected"
var PREVIEW_VALUES = [PREVIEW_NONE, PREVIEW_STILL, PREVIEW_LIVE_SELECTED]

var ACTIVATION_EXPLICIT = "explicit"
var ACTIVATION_RELEASE = "release"
var ACTIVATION_VALUES = [ACTIVATION_EXPLICIT, ACTIVATION_RELEASE]

var SPECIAL_WORKSPACE_PREFIX = "special:"
var MINIMIZED_WORKSPACE_NAME = SPECIAL_WORKSPACE_PREFIX + "minimized"
var NO_WORKSPACE_KEY = "none"
var GROUP_SELECTION_PREFIX = "group:"

var PILL_ALL = "all"
var PILL_WORKSPACE = "workspace"
var PILL_LABEL = "label"

function stringValue(value) {
  return String(value === undefined || value === null ? "" : value)
}

function boundedNumber(value, fallback, minimum, maximum) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== "number" && typeof value !== "string") return fallback
  if (typeof value === "string" && !value.trim()) return fallback
  var number = Number(value)
  if (!isFinite(number)) return fallback
  return Math.max(minimum, Math.min(maximum, number))
}

function parsePayload(payload) {
  if (!payload) return {}
  if (typeof payload === "object") return payload
  try {
    var parsed = JSON.parse(String(payload))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch (error) {
    return {}
  }
}

// Repeated summons normally carry only a direction. Keep that hot path as a
// selection move; any other invocation key may change filtering, grouping, or
// presentation and therefore still needs the full option/model refresh.
function hasInvocationOverrides(payload) {
  var invocation = payload || {}
  for (var key in invocation) if (key !== "direction") return true
  return false
}

function mergeInvocationOverrides(current, payload) {
  var result = {}
  var previous = current || {}
  var incoming = payload || {}
  for (var key in previous) if (key !== "direction") result[key] = previous[key]
  if (incoming.filter !== undefined || incoming.scope !== undefined) {
    delete result.filter
    delete result.scope
  }
  if (incoming.view !== undefined || incoming.groupByWorkspace !== undefined) {
    delete result.view
    delete result.groupByWorkspace
  }
  for (var nextKey in incoming) if (nextKey !== "direction") result[nextKey] = incoming[nextKey]
  return result
}

function optionApplicationKey(options) {
  var value = options || {}
  return JSON.stringify({
    filter: value.filter || null,
    filterExplicit: value.filterExplicit === true,
    view: value.view,
    viewExplicit: value.viewExplicit === true,
    workspaceOrder: value.workspaceOrder,
    workspaceOrderExplicit: value.workspaceOrderExplicit === true,
    workspaceNames: value.workspaceNames || {},
    stickyFilter: value.stickyFilter === true,
    previewMode: value.previewMode,
    activation: value.activation,
    showMinimized: value.showMinimized === true,
    showSpecialWorkspaces: value.showSpecialWorkspaces === true,
    maxInitialCaptures: value.maxInitialCaptures,
    animationMs: value.animationMs
  })
}

function enumValue(value, allowed, fallback) {
  var result = stringValue(value)
  return allowed.indexOf(result) >= 0 ? result : fallback
}

function boolValue(value, fallback) {
  if (value === true || value === "true") return true
  if (value === false || value === "false") return false
  return fallback
}

function normalizedWorkspaceName(value) {
  if (typeof value !== "string") return ""
  return value.replace(/\s+/g, " ").trim().slice(0, 48)
}

// Local aliases deliberately use positive numeric workspace IDs. They label
// the switcher's stable 1..N cards without changing Hyprland's workspace name
// or trying to pin an alias to a compositor-assigned special-workspace ID.
function normalizeWorkspaceNames(value) {
  var result = {}
  if (!value || typeof value !== "object" || Array.isArray(value)) return result
  for (var key in value) {
    var id = Number(key)
    var name = normalizedWorkspaceName(value[key])
    if (!isFinite(id) || Math.floor(id) !== id || id <= 0 || !name) continue
    result[String(id)] = name
  }
  return result
}

function workspaceAlias(workspaceNames, workspaceId) {
  var id = Number(workspaceId)
  if (!isFinite(id) || Math.floor(id) !== id || id <= 0) return ""
  var names = workspaceNames || {}
  return normalizedWorkspaceName(names[String(id)])
}

// A filter is {kind: "all"} or {kind: "workspace", id}. A null id means "the
// workspace focused when the switcher opens" and is resolved by the caller.
function normalizeFilter(value) {
  if (value === undefined || value === null) return null
  if (typeof value === "number") {
    return isFinite(value) ? { kind: FILTER_WORKSPACE, id: value } : null
  }
  if (typeof value === "object") {
    var kind = stringValue(value.kind)
    if (kind === FILTER_ALL) return { kind: FILTER_ALL }
    if (kind === FILTER_WORKSPACE) {
      var rawId = value.id
      if (rawId === undefined || rawId === null || !stringValue(rawId).trim())
        return { kind: FILTER_WORKSPACE, id: null }
      if (typeof rawId !== "number" && typeof rawId !== "string")
        return { kind: FILTER_WORKSPACE, id: null }
      var id = Number(rawId)
      return { kind: FILTER_WORKSPACE, id: isFinite(id) ? id : null }
    }
    return null
  }
  var text = stringValue(value).trim().toLowerCase()
  if (!text) return null
  // Legacy scope names: "monitor" collapses into "all" because workspace pills
  // group by monitor instead of filtering by it.
  if (text === FILTER_ALL || text === LEGACY_FILTER_MONITOR) return { kind: FILTER_ALL }
  if (text === FILTER_WORKSPACE || text === LEGACY_FILTER_CURRENT)
    return { kind: FILTER_WORKSPACE, id: null }
  var number = Number(text)
  if (isFinite(number)) return { kind: FILTER_WORKSPACE, id: number }
  return null
}

function effectiveOptions(settings, payload) {
  var stored = settings || {}
  var invocation = payload || {}

  function pick(key, fallback) {
    if (invocation[key] !== undefined) return invocation[key]
    if (stored[key] !== undefined) return stored[key]
    return fallback
  }

  var filterSource = invocation.filter !== undefined ? invocation.filter
    : invocation.scope !== undefined ? invocation.scope
    : stored.defaultFilter !== undefined ? stored.defaultFilter
    : stored.defaultScope !== undefined ? stored.defaultScope
    : FILTER_ALL

  // Legacy boolean groupByWorkspace maps onto the view enum.
  var viewFallback = boolValue(pick("groupByWorkspace", false), false)
    ? VIEW_GROUPED : VIEW_WORKSPACES

  return {
    filter: normalizeFilter(filterSource) || { kind: FILTER_ALL },
    filterExplicit: invocation.filter !== undefined || invocation.scope !== undefined,
    view: enumValue(pick("view", viewFallback), VIEW_VALUES, viewFallback),
    viewExplicit: invocation.view !== undefined || invocation.groupByWorkspace !== undefined,
    workspaceOrder: enumValue(
      pick("workspaceOrder", WORKSPACE_ORDER_RECENT),
      WORKSPACE_ORDER_VALUES,
      WORKSPACE_ORDER_RECENT),
    workspaceOrderExplicit: invocation.workspaceOrder !== undefined,
    workspaceNames: normalizeWorkspaceNames(stored.workspaceNames),
    stickyFilter: boolValue(pick("stickyFilter", false), false),
    previewMode: enumValue(pick("previewMode", PREVIEW_STILL), PREVIEW_VALUES, PREVIEW_STILL),
    activation: enumValue(pick("activation", ACTIVATION_EXPLICIT), ACTIVATION_VALUES, ACTIVATION_EXPLICIT),
    showMinimized: boolValue(pick("showMinimized", true), true),
    showSpecialWorkspaces: boolValue(pick("showSpecialWorkspaces", true), true),
    maxInitialCaptures: Math.round(boundedNumber(pick("maxInitialCaptures", 20), 20, 1, 20)),
    animationMs: Math.round(boundedNumber(pick("animationMs", 140), 140, 0, 500)),
    query: stringValue(pick("query", "")).slice(0, 128),
    direction: Math.sign(boundedNumber(pick("direction", 1), 1, -1, 1))
  }
}

function recordSearchText(record, workspaceNames) {
  if (!record) return ""
  return [
    record.appName,
    record.appId,
    record.title,
    workspaceAlias(workspaceNames, record.workspaceId),
    record.workspaceName,
    record.monitorName
  ].join(" ").toLowerCase()
}

function queryMatches(record, query, workspaceNames) {
  var terms = stringValue(query).toLowerCase().trim().split(/\s+/)
  var haystack = recordSearchText(record, workspaceNames)
  for (var i = 0; i < terms.length; i++) {
    if (terms[i] && haystack.indexOf(terms[i]) < 0) return false
  }
  return true
}

function isSpecialWorkspace(record) {
  if (!record) return false
  return Number(record.workspaceId) < 0
    || stringValue(record.workspaceName).indexOf(SPECIAL_WORKSPACE_PREFIX) === 0
}

function isMinimizedWindow(record) {
  if (!record) return false
  return record.minimized === true
    || stringValue(record.workspaceName).trim().toLowerCase() === MINIMIZED_WORKSPACE_NAME
}

// Minimized windows the visibility toggle can actually reveal. Windows the
// special-workspace gate already drops do not count, so the control never
// offers to show windows that a second gate keeps out. The query and the
// workspace filter are ignored on purpose: the toggle is a session-level
// control, and it must not appear and disappear while the user types.
function minimizedCount(records, showSpecialWorkspaces) {
  var values = records || []
  var count = 0
  for (var i = 0; i < values.length; i++) {
    var record = values[i]
    if (!record || !isMinimizedWindow(record)) continue
    if (!showSpecialWorkspaces && isSpecialWorkspace(record)) continue
    count++
  }
  return count
}

function filterMatches(record, filter, context) {
  if (!filter || filter.kind !== FILTER_WORKSPACE) return true
  var state = context || {}
  var target = filter.id === undefined || filter.id === null
    ? Number(state.focusedWorkspaceId)
    : Number(filter.id)

  // Windows without a workspace association are retained rather than dropped.
  if (record.workspaceId === undefined || record.workspaceId === null) return true
  if (record.workspaceActive === true && isSpecialWorkspace(record)
      && Number(state.focusedWorkspaceId) === target) return true
  return Number(record.workspaceId) === target
}

function filterWindows(records, query, filter, context, showMinimized, showSpecialWorkspaces, workspaceNames) {
  var values = records || []
  var result = []
  for (var i = 0; i < values.length; i++) {
    var record = values[i]
    if (!record) continue
    if (!showMinimized && isMinimizedWindow(record)) continue
    if (!showSpecialWorkspaces && isSpecialWorkspace(record)) continue
    if (!filterMatches(record, filter, context)) continue
    if (!queryMatches(record, query, workspaceNames)) continue
    result.push(record)
  }
  return result
}

function workspaceChipLabel(record) {
  if (!record) return ""
  var name = stringValue(record.workspaceName)
  if (name.indexOf(SPECIAL_WORKSPACE_PREFIX) === 0)
    return name.slice(SPECIAL_WORKSPACE_PREFIX.length) || "special"
  if (name) return name
  if (record.workspaceId !== undefined && record.workspaceId !== null)
    return String(record.workspaceId)
  return ""
}

function occupiedWorkspaces(records, context) {
  var values = records || []
  var state = context || {}
  var focusedId = Number(state.focusedWorkspaceId)
  var rows = []
  var byKey = {}

  for (var i = 0; i < values.length; i++) {
    var record = values[i]
    if (!record || record.workspaceId === undefined || record.workspaceId === null) continue
    var key = String(record.workspaceId)
    var row = byKey[key]
    if (!row) {
      row = {
        id: Number(record.workspaceId),
        label: workspaceChipLabel(record),
        special: isSpecialWorkspace(record),
        monitorName: stringValue(record.monitorName),
        focused: Number(record.workspaceId) === focusedId,
        urgent: false,
        count: 0
      }
      byKey[key] = row
      rows.push(row)
    }
    if (record.urgent === true) row.urgent = true
    row.count++
  }

  rows.sort(function(left, right) {
    if (left.special !== right.special) return left.special ? 1 : -1
    if (left.special) return left.label < right.label ? -1 : left.label > right.label ? 1 : 0
    return left.id - right.id
  })
  return rows
}

// Header model: an All pill, then one pill per occupied workspace. When
// windows span more than one monitor, each monitor's pills follow a label row
// so the monitor concept only appears when it distinguishes anything.
function pillRows(records, context) {
  var values = records || []
  var rows = occupiedWorkspaces(values, context)
  var result = [{ type: PILL_ALL, label: "All", count: values.length }]

  function pushPill(row) {
    result.push({
      type: PILL_WORKSPACE,
      id: row.id,
      label: row.label,
      count: row.count,
      focused: row.focused,
      urgent: row.urgent,
      special: row.special
    })
  }

  var monitors = []
  for (var i = 0; i < rows.length; i++) {
    var name = rows[i].monitorName
    if (name && monitors.indexOf(name) < 0) monitors.push(name)
  }

  if (monitors.length > 1) {
    for (var j = 0; j < monitors.length; j++) {
      result.push({ type: PILL_LABEL, label: monitors[j] })
      for (var k = 0; k < rows.length; k++) {
        if (rows[k].monitorName === monitors[j]) pushPill(rows[k])
      }
    }
    for (var l = 0; l < rows.length; l++) {
      if (!rows[l].monitorName) pushPill(rows[l])
    }
  } else {
    for (var m = 0; m < rows.length; m++) pushPill(rows[m])
  }
  return result
}

function filterLabel(filter, records) {
  if (!filter || filter.kind !== FILTER_WORKSPACE
      || filter.id === undefined || filter.id === null) return ""
  var values = records || []
  for (var i = 0; i < values.length; i++) {
    var record = values[i]
    if (!record || record.workspaceId === undefined || record.workspaceId === null) continue
    if (Number(record.workspaceId) !== Number(filter.id)) continue
    if (isSpecialWorkspace(record)) return workspaceChipLabel(record)
    return "workspace " + (stringValue(record.workspaceName) || record.workspaceId)
  }
  return "workspace " + filter.id
}

function countLabel(filteredCount, totalCount, filter, query, label) {
  var filtered = Math.max(0, Number(filteredCount) || 0)
  var total = Math.max(0, Number(totalCount) || 0)
  var everything = !filter || filter.kind === FILTER_ALL
  if (everything && !stringValue(query).trim())
    return total + (total === 1 ? " window" : " windows")
  var text = filtered + " of " + total
  if (!everything && label) text += " · " + label
  return text
}

function workspaceShortcutKey(workspaceId, label) {
  var id = Number(workspaceId)
  if (!isFinite(id) || Math.floor(id) !== id || String(label) !== String(id)) return ""
  if (id >= 1 && id <= 9) return String(id)
  return id === 10 ? "0" : ""
}

// Footer key legends. The footer is the only place that teaches the keymap,
// so it names the keys the current view actually answers to rather than the
// whole map: a hint for a control the header is hiding is a hint that lies.
function footerHints(view, activation, minimizedCount) {
  var primary = [
    { keys: ["Tab"], label: "select" },
    activation === ACTIVATION_RELEASE
      ? { keys: ["Alt/Meta/Super"], label: "release to switch" }
      : { keys: ["Enter"], label: "switch" },
    { keys: ["Esc"], label: "cancel" }
  ]

  var secondary = []
  function addWorkspaceFilterHints() {
    secondary.push({ keys: ["Ctrl", "1…9"], label: "filter" })
    secondary.push({ keys: ["Ctrl", "0"], label: "workspace 10" })
  }

  if (view === VIEW_WORKSPACES) {
    secondary.push({ keys: ["F2"], label: "rename" })
    addWorkspaceFilterHints()
    if (Number(minimizedCount) > 0) secondary.push({ keys: ["Ctrl", "M"], label: "minimized" })
    secondary.push({ keys: ["Ctrl", "O"], label: "order" })
    secondary.push({ keys: ["Ctrl", "W"], label: "windows" })
  } else {
    addWorkspaceFilterHints()
    secondary.push({ keys: ["Ctrl", "A"], label: "all" })
    if (Number(minimizedCount) > 0) secondary.push({ keys: ["Ctrl", "M"], label: "minimized" })
    secondary.push({ keys: ["Ctrl", "G"], label: view === VIEW_GROUPED ? "ungroup" : "group" })
    if (view === VIEW_GROUPED) secondary.push({ keys: ["Ctrl", "O"], label: "order" })
    secondary.push({ keys: ["Ctrl", "W"], label: "workspaces" })
  }

  return { primary: primary, secondary: secondary }
}

function digitWorkspaceId(digit) {
  var value = Math.floor(Number(digit) || 0)
  return value === 0 ? 10 : value
}

function viewCountLabel(view, workspaceCount, filteredCount, totalCount, filter, query, label) {
  var base = countLabel(filteredCount, totalCount, filter, query, label)
  if (view !== VIEW_WORKSPACES) return base
  var count = Math.max(0, Number(workspaceCount) || 0)
  return count + (count === 1 ? " workspace" : " workspaces") + " · " + base
}

function normalizedRect(rect, monitorRect) {
  if (!rect || !monitorRect) return null
  var monitorWidth = Number(monitorRect.width)
  var monitorHeight = Number(monitorRect.height)
  if (!(monitorWidth > 0) || !(monitorHeight > 0)) return null
  var width = Number(rect.width) / monitorWidth
  var height = Number(rect.height) / monitorHeight
  if (!(width > 0) || !(height > 0)) return null
  width = Math.max(0.05, Math.min(1, width))
  height = Math.max(0.05, Math.min(1, height))
  var x = (Number(rect.x) - (Number(monitorRect.x) || 0)) / monitorWidth
  var y = (Number(rect.y) - (Number(monitorRect.y) || 0)) / monitorHeight
  x = Math.max(0, Math.min(1 - width, x))
  y = Math.max(0, Math.min(1 - height, y))
  return { x: x, y: y, width: width, height: height }
}

// Miniature workspace composition: normalized rectangles for each window
// inside a workspace card preview. Real window geometry is used when every
// visible window reports one; otherwise the visible windows fall back to an
// even tile grid. Minimized windows are hidden rather than guessed at.
function workspaceLayout(windows) {
  var values = windows || []
  var result = []
  var visible = []
  var spatial = true

  for (var i = 0; i < values.length; i++) {
    var record = values[i]
    var hidden = !record || record.minimized === true
    result.push({ hidden: hidden, x: 0, y: 0, width: 0, height: 0 })
    if (hidden) continue
    visible.push(i)
    var rect = normalizedRect(record.rect, record.monitorRect)
    if (rect) {
      result[i].x = rect.x
      result[i].y = rect.y
      result[i].width = rect.width
      result[i].height = rect.height
    } else {
      spatial = false
    }
  }
  if (spatial || visible.length === 0) return result

  var columns = Math.ceil(Math.sqrt(visible.length))
  var rows = Math.ceil(visible.length / columns)
  var inset = 0.03
  for (var j = 0; j < visible.length; j++) {
    var cell = result[visible[j]]
    cell.x = (j % columns) / columns + inset
    cell.y = Math.floor(j / columns) / rows + inset
    cell.width = 1 / columns - inset * 2
    cell.height = 1 / rows - inset * 2
  }
  return result
}

// The miniature that liveSelected should stream: the first entry of a
// workspace layout that is actually drawn (minimized windows are hidden).
function firstShownIndex(layout) {
  var values = layout || []
  for (var i = 0; i < values.length; i++) {
    if (values[i] && values[i].hidden !== true) return i
  }
  return -1
}

// Capture ordering inside a workspace card: each drawn miniature's 0-based
// position among drawn miniatures, -1 for hidden entries. Budgeting by this
// ordinal means hidden windows never consume capture slots, so the first
// drawn miniature (the liveSelected target) always holds slot 0.
function shownOrdinals(layout) {
  var values = layout || []
  var result = []
  var next = 0
  for (var i = 0; i < values.length; i++) {
    if (values[i] && values[i].hidden !== true) result.push(next++)
    else result.push(-1)
  }
  return result
}

// The workspace to preselect when the switcher opens in workspace view: the
// workspace of the most recent window that is not on the focused workspace.
function previousWorkspaceKey(records, focusedWorkspaceId, recentWorkspaceKeys) {
  var values = records || []
  var recent = recentWorkspaceKeys || []
  for (var recentIndex = 0; recentIndex < recent.length; recentIndex++) {
    var recentKey = stringValue(recent[recentIndex])
    if (!recentKey || Number(recentKey) === Number(focusedWorkspaceId)) continue
    for (var recordIndex = 0; recordIndex < values.length; recordIndex++) {
      var candidate = values[recordIndex]
      if (candidate && candidate.workspaceId !== undefined && candidate.workspaceId !== null
          && String(candidate.workspaceId) === recentKey)
        return recentKey
    }
  }
  for (var i = 0; i < values.length; i++) {
    var record = values[i]
    if (!record || record.workspaceId === undefined || record.workspaceId === null) continue
    if (Number(record.workspaceId) !== Number(focusedWorkspaceId)) return String(record.workspaceId)
  }
  return ""
}

function noteWorkspaceMru(keys, workspaceId, limit) {
  var values = keys || []
  var key = workspaceId === undefined || workspaceId === null
    ? "" : stringValue(workspaceId).trim()
  var maximum = Math.max(1, Number(limit) || 100)
  if (!key) return values.slice(0, maximum)
  var result = [key]
  for (var i = 0; i < values.length && result.length < maximum; i++) {
    var existing = stringValue(values[i]).trim()
    if (existing && existing !== key && result.indexOf(existing) < 0) result.push(existing)
  }
  return result
}

// Fill event history after a shell/plugin reload. Window MRU is only a seed:
// focused-workspace events become the exact source from this point onward.
function completeWorkspaceMru(keys, records, focusedWorkspaceId, limit) {
  var maximum = Math.max(1, Number(limit) || 100)
  var result = noteWorkspaceMru(keys, focusedWorkspaceId, maximum)
  var values = records || []
  for (var i = 0; i < values.length && result.length < maximum; i++) {
    var record = values[i]
    if (!record || record.workspaceId === undefined || record.workspaceId === null) continue
    var key = String(record.workspaceId)
    if (result.indexOf(key) < 0) result.push(key)
  }
  return result
}

// Stable ordering for section views. Regular workspaces come first, then other
// special workspaces, the minimized workspace, and unassociated windows. MRU
// order is preserved inside each workspace.
function orderByWorkspace(records, workspaceOrder, recentWorkspaceKeys) {
  var values = (records || []).map(function(record, index) {
    return { record: record, index: index }
  })
  var mode = enumValue(
    workspaceOrder,
    WORKSPACE_ORDER_VALUES,
    WORKSPACE_ORDER_NUMBER)
  var recent = recentWorkspaceKeys || []
  values.sort(function(left, right) {
    function rank(entry) {
      if (entry.record.workspaceId === undefined || entry.record.workspaceId === null) return 3
      if (stringValue(entry.record.workspaceName).trim().toLowerCase()
          === MINIMIZED_WORKSPACE_NAME) return 2
      return isSpecialWorkspace(entry.record) ? 1 : 0
    }
    var leftRank = rank(left)
    var rightRank = rank(right)
    if (leftRank !== rightRank) return leftRank - rightRank
    if (mode === WORKSPACE_ORDER_RECENT && leftRank <= 1) {
      var leftRecent = recent.indexOf(String(left.record.workspaceId))
      var rightRecent = recent.indexOf(String(right.record.workspaceId))
      if (leftRecent < 0) leftRecent = recent.length
      if (rightRecent < 0) rightRecent = recent.length
      if (leftRecent !== rightRecent) return leftRecent - rightRecent
    }
    if (leftRank === 0) {
      var delta = Number(left.record.workspaceId) - Number(right.record.workspaceId)
      if (delta) return delta
    }
    if (leftRank === 1) {
      var leftName = workspaceChipLabel(left.record)
      var rightName = workspaceChipLabel(right.record)
      if (leftName !== rightName) return leftName < rightName ? -1 : 1
    }
    return left.index - right.index
  })
  return values.map(function(entry) { return entry.record })
}

// Consecutive runs of workspace-ordered records, with flat-list offsets so the
// section views and grouped navigation share one index space.
function groupWindows(records, totalRecords, workspaceNames) {
  var values = records || []
  var groups = []

  function groupKey(record) {
    return record && record.workspaceId !== undefined && record.workspaceId !== null
      ? String(record.workspaceId) : NO_WORKSPACE_KEY
  }

  var totals = {}
  var totalValues = totalRecords || values
  for (var totalIndex = 0; totalIndex < totalValues.length; totalIndex++) {
    var totalRecord = totalValues[totalIndex]
    if (!totalRecord) continue
    var totalKey = groupKey(totalRecord)
    totals[totalKey] = (totals[totalKey] || 0) + 1
  }

  for (var i = 0; i < values.length; i++) {
    var record = values[i]
    if (!record) continue
    var key = groupKey(record)
    var current = groups.length > 0 ? groups[groups.length - 1] : null
    if (!current || current.key !== key) {
      var defaultLabel = "No workspace"
      var label = defaultLabel
      if (key !== NO_WORKSPACE_KEY) {
        var alias = workspaceAlias(workspaceNames, record.workspaceId)
        defaultLabel = isSpecialWorkspace(record)
          ? workspaceChipLabel(record)
          : "Workspace " + (stringValue(record.workspaceName) || record.workspaceId)
        label = alias || defaultLabel
      }
      current = {
        key: key,
        id: record.workspaceId,
        label: label,
        defaultLabel: defaultLabel,
        startIndex: i,
        size: 0,
        totalSize: totals[key] || 0
      }
      groups.push(current)
    }
    current.size++
    current.totalSize = Math.max(current.totalSize, current.size)
  }
  return groups
}

function groupIndexFor(groups, index) {
  var values = groups || []
  for (var i = 0; i < values.length; i++) {
    if (index >= values[i].startIndex && index < values[i].startIndex + values[i].size) return i
  }
  return 0
}

function workspaceLabel(record) {
  if (!record) return ""
  var workspace = stringValue(record.workspaceName)
  if (!workspace && record.workspaceId !== undefined && record.workspaceId !== null)
    workspace = "Workspace " + record.workspaceId
  if (workspace.indexOf(SPECIAL_WORKSPACE_PREFIX) === 0)
    workspace = workspace.slice(SPECIAL_WORKSPACE_PREFIX.length) || "Special"
  var monitor = stringValue(record.monitorName)
  if (workspace && monitor) return workspace + " · " + monitor
  return workspace || monitor
}

if (typeof module !== "undefined") {
  module.exports = {
    FILTER_ALL: FILTER_ALL,
    FILTER_WORKSPACE: FILTER_WORKSPACE,
    VIEW_WINDOWS: VIEW_WINDOWS,
    VIEW_GROUPED: VIEW_GROUPED,
    VIEW_WORKSPACES: VIEW_WORKSPACES,
    VIEW_VALUES: VIEW_VALUES,
    WORKSPACE_ORDER_RECENT: WORKSPACE_ORDER_RECENT,
    WORKSPACE_ORDER_NUMBER: WORKSPACE_ORDER_NUMBER,
    WORKSPACE_ORDER_VALUES: WORKSPACE_ORDER_VALUES,
    PREVIEW_NONE: PREVIEW_NONE,
    PREVIEW_STILL: PREVIEW_STILL,
    PREVIEW_LIVE_SELECTED: PREVIEW_LIVE_SELECTED,
    PREVIEW_VALUES: PREVIEW_VALUES,
    ACTIVATION_EXPLICIT: ACTIVATION_EXPLICIT,
    ACTIVATION_RELEASE: ACTIVATION_RELEASE,
    ACTIVATION_VALUES: ACTIVATION_VALUES,
    SPECIAL_WORKSPACE_PREFIX: SPECIAL_WORKSPACE_PREFIX,
    MINIMIZED_WORKSPACE_NAME: MINIMIZED_WORKSPACE_NAME,
    NO_WORKSPACE_KEY: NO_WORKSPACE_KEY,
    GROUP_SELECTION_PREFIX: GROUP_SELECTION_PREFIX,
    PILL_ALL: PILL_ALL,
    PILL_WORKSPACE: PILL_WORKSPACE,
    PILL_LABEL: PILL_LABEL,
    parsePayload: parsePayload,
    hasInvocationOverrides: hasInvocationOverrides,
    mergeInvocationOverrides: mergeInvocationOverrides,
    optionApplicationKey: optionApplicationKey,
    normalizeWorkspaceNames: normalizeWorkspaceNames,
    workspaceAlias: workspaceAlias,
    normalizeFilter: normalizeFilter,
    effectiveOptions: effectiveOptions,
    queryMatches: queryMatches,
    isSpecialWorkspace: isSpecialWorkspace,
    isMinimizedWindow: isMinimizedWindow,
    minimizedCount: minimizedCount,
    filterMatches: filterMatches,
    filterWindows: filterWindows,
    workspaceChipLabel: workspaceChipLabel,
    occupiedWorkspaces: occupiedWorkspaces,
    pillRows: pillRows,
    filterLabel: filterLabel,
    countLabel: countLabel,
    viewCountLabel: viewCountLabel,
    digitWorkspaceId: digitWorkspaceId,
    workspaceShortcutKey: workspaceShortcutKey,
    footerHints: footerHints,
    workspaceLayout: workspaceLayout,
    firstShownIndex: firstShownIndex,
    shownOrdinals: shownOrdinals,
    previousWorkspaceKey: previousWorkspaceKey,
    noteWorkspaceMru: noteWorkspaceMru,
    completeWorkspaceMru: completeWorkspaceMru,
    orderByWorkspace: orderByWorkspace,
    groupWindows: groupWindows,
    groupIndexFor: groupIndexFor,
    workspaceLabel: workspaceLabel
  }
}
