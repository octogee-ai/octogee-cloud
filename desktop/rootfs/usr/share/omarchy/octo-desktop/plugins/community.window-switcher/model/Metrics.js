// Card sizing: grid metrics for the fitted window grid and flow metrics for
// scrolling section views. Standalone on purpose — this file is loaded both
// by QML and by the Node test harness, so it must not depend on any other
// model file.

function gridMetrics(count, availableWidth, availableHeight, gap, minimumWidth, previewAspect, chromeHeight) {
  var total = Math.max(0, Math.floor(Number(count) || 0))
  var width = Math.max(1, Number(availableWidth) || 1)
  var height = Math.max(1, Number(availableHeight) || 1)
  var spacing = Math.max(0, Number(gap) || 0)
  var minimum = Math.max(80, Number(minimumWidth) || 160)
  var aspect = Math.max(0.5, Number(previewAspect) || 1.6)
  var chrome = Math.max(0, Number(chromeHeight) || 64)

  if (total === 0) {
    return { columns: 1, rows: 1, cellWidth: width, cellHeight: height, cardWidth: width, cardHeight: height }
  }

  var maximumColumns = Math.min(total, Math.max(1, Math.floor((width + spacing) / (minimum + spacing))))
  if (total <= 4) maximumColumns = total

  // Fitted-first: pick the column count that maximizes preview area inside
  // the viewport, however many windows there are. Only when even the best
  // fitted layout would push cards below the minimum readable width does the
  // view fall back to scrolling rows of minimum-width cards, so large window
  // counts stay readable and small counts on large screens stay large.
  var startColumns = total <= 4 ? total : 1
  var best = null

  for (var columns = startColumns; columns <= maximumColumns; columns++) {
    var rows = Math.ceil(total / columns)
    var cellWidth = width / columns
    var cellHeight = height / rows
    var availableCardWidth = Math.max(1, cellWidth - spacing)
    var availableCardHeight = Math.max(1, cellHeight - spacing)
    var previewWidth = Math.min(availableCardWidth, Math.max(1, (availableCardHeight - chrome) * aspect))
    var previewHeight = previewWidth / aspect
    var cardHeight = previewHeight + chrome
    var score = previewWidth * previewHeight

    if (!best || score > best.score) {
      best = {
        score: score,
        columns: columns,
        rows: rows,
        cellWidth: cellWidth,
        cellHeight: cellHeight,
        cardWidth: Math.floor(previewWidth),
        cardHeight: Math.floor(cardHeight)
      }
    }
  }

  // Up to four windows always keep the fitted single row, even on viewports
  // too narrow for full-size cards; anything larger that cannot reach the
  // readable minimum scrolls instead of shrinking further.
  if (best && (best.cardWidth >= minimum || total <= 4)) {
    delete best.score
    return best
  }

  var scrollingColumns = maximumColumns
  var scrollingRows = Math.ceil(total / scrollingColumns)
  var scrollingCellWidth = width / scrollingColumns
  var scrollingWidth = Math.max(1, scrollingCellWidth - spacing)
  var scrollingHeight = scrollingWidth / aspect + chrome
  return {
    columns: scrollingColumns,
    rows: scrollingRows,
    cellWidth: scrollingCellWidth,
    cellHeight: scrollingHeight + spacing,
    cardWidth: Math.floor(scrollingWidth),
    cardHeight: Math.floor(scrollingHeight)
  }
}

// Uniform card sizing for section views: every section shares one column
// count derived from the available width, so cards align across sections and
// the view scrolls vertically.
function flowMetrics(availableWidth, gap, minimumWidth, previewAspect, chromeHeight) {
  var width = Math.max(1, Number(availableWidth) || 1)
  var spacing = Math.max(0, Number(gap) || 0)
  var minimum = Math.max(80, Number(minimumWidth) || 160)
  var aspect = Math.max(0.5, Number(previewAspect) || 1.6)
  var chrome = Math.max(0, Number(chromeHeight) || 64)

  var columns = Math.max(1, Math.floor((width + spacing) / (minimum + spacing)))
  var cellWidth = width / columns
  var cardWidth = Math.max(1, cellWidth - spacing)
  var cardHeight = cardWidth / aspect + chrome
  return {
    columns: columns,
    cellWidth: cellWidth,
    cellHeight: cardHeight + spacing,
    cardWidth: Math.floor(cardWidth),
    cardHeight: Math.floor(cardHeight)
  }
}

// Compact rows: cells hug their cards vertically, so stacked rows read as
// rows instead of cards floating in stretched cells. The caller centers the
// resulting block in the viewport.
function compactRows(metrics, gap) {
  var spacing = Math.max(0, Number(gap) || 0)
  var result = {}
  for (var key in metrics) result[key] = metrics[key]
  result.cellHeight = Math.min(result.cellHeight, result.cardHeight + spacing)
  return result
}

if (typeof module !== "undefined") {
  module.exports = {
    gridMetrics: gridMetrics,
    flowMetrics: flowMetrics,
    compactRows: compactRows
  }
}
