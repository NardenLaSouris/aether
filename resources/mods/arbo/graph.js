/*
 * Lane layout of a commit graph (commits newest first, as `git log --date-order` gives them).
 * Each row gets the column of its commit and the lines going down to the next row.
 */
/* global self, module */
;(function (root) {
  'use strict'

  function layoutGraph(commits) {
    var lanes = []
    var rows = []
    var width = 0
    for (var index = 0; index < commits.length; index++) {
      var commit = commits[index]
      var column = lanes.indexOf(commit.hash)
      if (column < 0) {
        column = lanes.indexOf(null)
        if (column < 0) {
          column = lanes.length
          lanes.push(null)
        }
      }
      // Other lanes waiting for this commit end here: their incoming lines bend into the node.
      var converging = []
      for (var laneIndex = 0; laneIndex < lanes.length; laneIndex++) {
        if (laneIndex !== column && lanes[laneIndex] === commit.hash) converging.push(laneIndex)
      }
      var previous = rows[rows.length - 1]
      if (previous && converging.length) {
        previous.lines.forEach(function (line) {
          if (converging.indexOf(line.to) >= 0) line.to = column
        })
      }

      var after = lanes.slice()
      converging.forEach(function (laneIndex) {
        after[laneIndex] = null
      })
      var parents = commit.parents || []
      after[column] = parents.length ? parents[0] : null
      // Merge parents already followed by another lane: the node joins that lane.
      var joins = []
      for (var parentIndex = 1; parentIndex < parents.length; parentIndex++) {
        var parent = parents[parentIndex]
        var existing = after.indexOf(parent)
        if (existing >= 0) {
          if (existing !== column) joins.push(existing)
          continue
        }
        var free = after.indexOf(null)
        if (free < 0) {
          free = after.length
          after.push(null)
        }
        after[free] = parent
      }

      var lines = []
      for (var target = 0; target < after.length; target++) {
        var hash = after[target]
        if (hash === null) continue
        // A lane that only passes by keeps its column; every other lane starts at the node.
        if (target !== column && lanes[target] === hash) lines.push({ from: target, to: target })
        else lines.push({ from: column, to: target })
      }
      joins.forEach(function (laneIndex) {
        lines.push({ from: column, to: laneIndex })
      })

      while (after.length && after[after.length - 1] === null) after.pop()
      width = Math.max(width, lanes.length, after.length, column + 1)
      rows.push({ hash: commit.hash, column: column, lines: lines })
      lanes = after
    }
    return { rows: rows, width: width }
  }

  var api = { layoutGraph: layoutGraph }
  root.ArboGraph = api
  if (typeof module === 'object' && module && module.exports) module.exports = api
})(typeof self !== 'undefined' ? self : globalThis)
