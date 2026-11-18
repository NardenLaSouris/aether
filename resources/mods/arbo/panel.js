/* Arbo: draws the commit graph of the active conversation's git repository. */
/* global window, document */
;(function () {
  'use strict'
  var ROW_HEIGHT = 26
  var LANE_WIDTH = 14
  var LEFT_PADDING = 10
  var COLORS = ['#c4a96a', '#86a18b', '#7fa6c9', '#d9a07b', '#b897c7', '#7db8ae', '#e07a6b', '#e3cd95']
  var SVG_NS = 'http://www.w3.org/2000/svg'

  var content = document.getElementById('content')
  var repositoryName = document.getElementById('repository-name')
  var branchBadge = document.getElementById('branch')
  var summary = document.getElementById('summary')
  var currentDirectory = null
  var loadCounter = 0

  function element(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function showMessage(text, isError) {
    content.replaceChildren(element('p', isError ? 'message error' : 'message', text))
  }

  function laneX(column) {
    return LEFT_PADDING + column * LANE_WIDTH
  }

  function rowY(row) {
    return row * ROW_HEIGHT + ROW_HEIGHT / 2
  }

  function relativeDate(timestamp) {
    var seconds = Math.round((Date.now() - timestamp) / 1000)
    if (seconds < 60) return 'à l’instant'
    var minutes = Math.round(seconds / 60)
    if (minutes < 60) return 'il y a ' + minutes + ' min'
    var hours = Math.round(minutes / 60)
    if (hours < 24) return 'il y a ' + hours + ' h'
    var days = Math.round(hours / 24)
    if (days < 31) return 'il y a ' + days + ' j'
    return new Date(timestamp).toLocaleDateString('fr-FR')
  }

  function folderName(path) {
    var parts = String(path).split(/[\\/]/).filter(Boolean)
    return parts[parts.length - 1] || path
  }

  function remoteLabel(url) {
    if (!url) return null
    var match = /[/:]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)
    return match ? match[1] : url
  }

  function render(data) {
    var commits = data.commits
    repositoryName.textContent = remoteLabel(data.remoteUrl) || folderName(data.repositoryRoot)
    repositoryName.title = data.repositoryRoot + (data.remoteUrl ? '\n' + data.remoteUrl : '')
    branchBadge.hidden = !data.currentBranch
    branchBadge.textContent = data.currentBranch || ''
    summary.textContent = commits.length + ' commit' + (commits.length > 1 ? 's' : '') + (data.truncated ? ' (les plus récents)' : '')
    if (!commits.length) {
      showMessage('Ce dépôt ne contient encore aucun commit.')
      return
    }

    var layout = window.ArboGraph.layoutGraph(commits)
    var graphWidth = LEFT_PADDING * 2 + Math.max(1, layout.width) * LANE_WIDTH
    var height = commits.length * ROW_HEIGHT
    var svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('width', String(graphWidth))
    svg.setAttribute('height', String(height))

    layout.rows.forEach(function (row, rowIndex) {
      if (rowIndex === layout.rows.length - 1) return
      row.lines.forEach(function (line) {
        var path = document.createElementNS(SVG_NS, 'path')
        var x1 = laneX(line.from)
        var y1 = rowY(rowIndex)
        var x2 = laneX(line.to)
        var y2 = rowY(rowIndex + 1)
        var middle = (y1 + y2) / 2
        path.setAttribute('d', x1 === x2 ? 'M' + x1 + ' ' + y1 + ' L' + x2 + ' ' + y2 : 'M' + x1 + ' ' + y1 + ' C' + x1 + ' ' + middle + ' ' + x2 + ' ' + middle + ' ' + x2 + ' ' + y2)
        path.setAttribute('stroke', COLORS[(line.from === row.column ? line.to : line.from) % COLORS.length])
        path.setAttribute('stroke-width', '2')
        path.setAttribute('fill', 'none')
        svg.appendChild(path)
      })
    })
    layout.rows.forEach(function (row, rowIndex) {
      var commit = commits[rowIndex]
      var dot = document.createElementNS(SVG_NS, 'circle')
      dot.setAttribute('cx', String(laneX(row.column)))
      dot.setAttribute('cy', String(rowY(rowIndex)))
      dot.setAttribute('r', commit.parents.length > 1 ? '3.5' : '4.5')
      dot.setAttribute('fill', commit.parents.length > 1 ? '#121513' : COLORS[row.column % COLORS.length])
      dot.setAttribute('stroke', COLORS[row.column % COLORS.length])
      dot.setAttribute('stroke-width', '2')
      svg.appendChild(dot)
    })

    var graph = element('div', 'graph')
    graph.style.height = height + 'px'
    graph.appendChild(svg)
    var list = element('div')
    list.style.paddingLeft = graphWidth + 'px'
    commits.forEach(function (commit) {
      var row = element('div', 'row')
      row.title = commit.hash + '\n' + commit.author + ' — ' + new Date(commit.timestamp).toLocaleString('fr-FR') + '\n\n' + commit.subject
      row.appendChild(element('span', 'hash', commit.hash.slice(0, 7)))
      commit.refs.forEach(function (ref) {
        var isHead = ref.indexOf('HEAD') === 0
        var isTag = ref.indexOf('tag: ') === 0
        row.appendChild(element('span', 'ref' + (isHead ? ' head' : '') + (isTag ? ' tag' : ''), ref.replace('HEAD -> ', '⏵ ').replace('tag: ', '')))
      })
      row.appendChild(element('span', 'subject', commit.subject))
      row.appendChild(element('span', 'meta', commit.author + ' · ' + relativeDate(commit.timestamp)))
      list.appendChild(row)
    })
    graph.appendChild(list)
    content.replaceChildren(graph)
  }

  function load(context) {
    var directory = context && context.workingDirectory
    currentDirectory = directory || null
    if (!directory) {
      repositoryName.textContent = '—'
      branchBadge.hidden = true
      summary.textContent = ''
      showMessage('Ouvrez une conversation : Arbo affiche le dépôt git de son dossier.')
      return
    }
    var ticket = ++loadCounter
    repositoryName.textContent = folderName(directory)
    showMessage('Lecture de l’historique git…')
    window.aether
      .call('git.log', { limit: 300 })
      .then(function (data) {
        if (ticket === loadCounter) render(data)
      })
      .catch(function (error) {
        if (ticket === loadCounter) showMessage(error.message, true)
      })
  }

  document.getElementById('refresh').addEventListener('click', function () {
    window.aether.context().then(load)
  })
  window.aether.onContext(function (context) {
    if ((context && context.workingDirectory) !== currentDirectory) load(context)
  })
  window.aether.context().then(load, function (error) {
    showMessage(error.message, true)
  })
})()
