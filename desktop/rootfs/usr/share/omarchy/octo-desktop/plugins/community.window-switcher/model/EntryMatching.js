// Desktop-entry matching: associate a runtime app id with its desktop entry.
// Standalone on purpose — this file is loaded both by QML and by the Node
// test harness, so it must not depend on any other model file.

var DESKTOP_FILE_SUFFIX = ".desktop"

function stringValue(value) {
  return String(value === undefined || value === null ? "" : value)
}

function normalizeDesktopId(value) {
  var result = stringValue(value).trim().toLowerCase()
  if (result.slice(-DESKTOP_FILE_SUFFIX.length) === DESKTOP_FILE_SUFFIX)
    result = result.slice(0, -DESKTOP_FILE_SUFFIX.length)
  return result
}

function normalizeMatchId(value) {
  return normalizeDesktopId(value)
    .replace(/^application:\/\//, "")
    .replace(/[\s_]+/g, "-")
}

function entryName(entry) {
  return stringValue(entry && (entry.name || entry.id))
}

function entryStartupClass(entry) {
  return stringValue(entry && (entry.startupClass || entry.startupWMClass))
}

function findDesktopEntry(appId, entries) {
  var runtimeId = normalizeMatchId(appId)
  if (!runtimeId || !entries) return null

  var exactIds = []
  var startupClasses = []
  var suffixes = []

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i]
    if (!entry) continue
    var desktopId = normalizeMatchId(entry.id)
    var startupClass = normalizeMatchId(entryStartupClass(entry))

    if (desktopId === runtimeId) exactIds.push(entry)
    if (startupClass && startupClass === runtimeId) startupClasses.push(entry)

    if (desktopId && (desktopId.slice(-(runtimeId.length + 1)) === "." + runtimeId
        || runtimeId.slice(-(desktopId.length + 1)) === "." + desktopId)) {
      suffixes.push(entry)
    }
  }

  if (exactIds.length === 1) return exactIds[0]
  if (startupClasses.length === 1) return startupClasses[0]
  if (suffixes.length === 1) return suffixes[0]
  return null
}

if (typeof module !== "undefined") {
  module.exports = {
    normalizeDesktopId: normalizeDesktopId,
    normalizeMatchId: normalizeMatchId,
    entryName: entryName,
    entryStartupClass: entryStartupClass,
    findDesktopEntry: findDesktopEntry
  }
}
