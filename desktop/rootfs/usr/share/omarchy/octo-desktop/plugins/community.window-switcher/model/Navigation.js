// Selection movement: sequential, grid, and grouped-grid navigation over a
// flat index space. Standalone on purpose — this file is loaded both by QML
// and by the Node test harness, so it must not depend on any other model file.

function initialSelection(count, direction) {
  var total = Math.max(0, Number(count) || 0)
  if (total === 0) return -1
  if (total === 1 || Number(direction) === 0) return 0
  return Number(direction) < 0 ? total - 1 : 1
}

function wrappedIndex(index, count) {
  var total = Math.max(0, Number(count) || 0)
  if (total === 0) return -1
  var value = Number(index) || 0
  return ((value % total) + total) % total
}

function moveSequential(index, direction, count) {
  return wrappedIndex((Number(index) || 0) + (Number(direction) < 0 ? -1 : 1), count)
}

function moveGrid(index, horizontal, vertical, count, columns) {
  var total = Math.max(0, Number(count) || 0)
  if (total === 0) return -1
  var current = wrappedIndex(index, total)
  var cols = Math.max(1, Math.floor(Number(columns) || 1))

  if (horizontal) {
    var rowStart = Math.floor(current / cols) * cols
    var rowEnd = Math.min(total - 1, rowStart + cols - 1)
    if (horizontal < 0) return current > rowStart ? current - 1 : rowEnd
    return current < rowEnd ? current + 1 : rowStart
  }
  if (!vertical) return current

  var column = current % cols
  var rows = Math.ceil(total / cols)
  var row = Math.floor(current / cols)
  var targetRow = ((row + (vertical < 0 ? -1 : 1)) % rows + rows) % rows
  var target = targetRow * cols + column
  if (target >= total) target = total - 1
  return Math.min(total - 1, target)
}

// Grid navigation across workspace sections: vertical moves stay in the same
// column, continuing into the neighbouring section past a section's edge;
// horizontal moves walk the flat order so they cross sections naturally.
function moveGrouped(index, horizontal, vertical, groupSizes, columns) {
  var sizes = []
  var total = 0
  var values = groupSizes || []
  for (var i = 0; i < values.length; i++) {
    var size = Math.max(0, Math.floor(Number(values[i]) || 0))
    if (size > 0) {
      sizes.push(size)
      total += size
    }
  }
  if (total === 0) return -1
  var current = wrappedIndex(index, total)
  if (horizontal) return moveSequential(current, horizontal, total)
  if (!vertical) return current

  var cols = Math.max(1, Math.floor(Number(columns) || 1))
  var group = 0
  var start = 0
  while (group < sizes.length - 1 && current >= start + sizes[group]) {
    start += sizes[group]
    group++
  }
  var offset = current - start
  var row = Math.floor(offset / cols)
  var column = offset % cols
  var rows = Math.ceil(sizes[group] / cols)
  var targetRow = row + (Number(vertical) < 0 ? -1 : 1)

  if (targetRow >= 0 && targetRow < rows) {
    var target = targetRow * cols + column
    if (target >= sizes[group]) target = sizes[group] - 1
    return start + target
  }

  var count = sizes.length
  var nextGroup = ((group + (Number(vertical) < 0 ? -1 : 1)) % count + count) % count
  var nextStart = 0
  for (var j = 0; j < nextGroup; j++) nextStart += sizes[j]
  var nextRows = Math.ceil(sizes[nextGroup] / cols)
  var nextRow = Number(vertical) < 0 ? nextRows - 1 : 0
  var nextTarget = nextRow * cols + column
  if (nextTarget >= sizes[nextGroup]) nextTarget = sizes[nextGroup] - 1
  return nextStart + nextTarget
}

// Return the smallest scroll change that makes one item visible.
function revealOffset(currentOffset, viewportSize, itemOffset, itemSize, minimum, maximum) {
  var current = Number(currentOffset) || 0
  var viewport = Math.max(0, Number(viewportSize) || 0)
  var top = Number(itemOffset) || 0
  var size = Math.max(0, Number(itemSize) || 0)
  var lower = Number(minimum) || 0
  var upper = Math.max(lower, Number(maximum) || 0)
  var target = current
  if (top < current) target = top
  else if (top + size > current + viewport) target = top + size - viewport
  return Math.max(lower, Math.min(upper, target))
}

if (typeof module !== "undefined") {
  module.exports = {
    initialSelection: initialSelection,
    wrappedIndex: wrappedIndex,
    moveSequential: moveSequential,
    moveGrid: moveGrid,
    moveGrouped: moveGrouped,
    revealOffset: revealOffset
  }
}
