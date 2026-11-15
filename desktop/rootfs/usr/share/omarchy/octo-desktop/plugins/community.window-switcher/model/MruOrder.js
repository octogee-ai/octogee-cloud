// Most-recently-used bookkeeping: the pruned key list and the ordering it
// imposes on window records. Standalone on purpose — this file is loaded both
// by QML and by the Node test harness, so it must not depend on any other
// model file.

function stringValue(value) {
  return String(value === undefined || value === null ? "" : value)
}

function liveKeySet(records) {
  var result = {}
  var values = records || []
  for (var i = 0; i < values.length; i++) {
    if (values[i] && values[i].key) result[values[i].key] = true
  }
  return result
}

function pruneMru(mruKeys, records, maximum) {
  var live = liveKeySet(records)
  var seen = {}
  var result = []
  var limit = Math.max(1, Number(maximum) || 200)
  var values = mruKeys || []

  for (var i = 0; i < values.length && result.length < limit; i++) {
    var key = stringValue(values[i])
    if (!key || seen[key] || !live[key]) continue
    seen[key] = true
    result.push(key)
  }
  return result
}

function noteMru(mruKeys, key, records, maximum) {
  var value = stringValue(key)
  var result = []
  if (value) result.push(value)
  var values = mruKeys || []
  for (var i = 0; i < values.length; i++) {
    if (values[i] !== value) result.push(values[i])
  }
  return pruneMru(result, records, maximum)
}

function orderByMru(records, mruKeys) {
  var values = (records || []).slice()
  var positions = {}
  var mru = mruKeys || []
  for (var i = 0; i < mru.length; i++) positions[mru[i]] = i

  values.sort(function(left, right) {
    var leftPosition = positions[left.key]
    var rightPosition = positions[right.key]
    var leftKnown = leftPosition !== undefined
    var rightKnown = rightPosition !== undefined
    if (leftKnown && rightKnown) return leftPosition - rightPosition
    if (leftKnown) return -1
    if (rightKnown) return 1
    return Number(left.sourceIndex || 0) - Number(right.sourceIndex || 0)
  })
  return values
}

if (typeof module !== "undefined") {
  module.exports = {
    pruneMru: pruneMru,
    noteMru: noteMru,
    orderByMru: orderByMru
  }
}
