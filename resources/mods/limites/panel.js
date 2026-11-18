/* Limites Claude: gauges of the usage limits, under the list of conversations. */
/* global window, document, LimitGauges */
;(function () {
  'use strict'
  // Fresh figures from Claude Code's usage API every 5 minutes while the panel is shown; each reply also
  // brings Claude Code's rate-limit figures in between.
  var REFRESH_MS = 5 * 60000

  var gauges = document.getElementById('gauges')
  var seen = document.getElementById('seen')
  var refreshButton = document.getElementById('refresh')
  var quota = null

  function element(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function lastSeen(current) {
    var latest = current.lastCheckAt || 0
    for (var index = 0; index < current.windows.length; index++) latest = Math.max(latest, current.windows[index].observedAt || 0)
    return latest
  }

  function render() {
    if (!quota) return
    var now = Date.now()
    var windows = LimitGauges.gaugeWindows(quota.windows)
    var children = []
    if (quota.block) {
      var reset = LimitGauges.formatReset(quota.block.resetsAt, now)
      children.push(element('p', 'blocked', quota.block.label + ' atteinte' + (reset ? ' · reprise ' + reset : '')))
    }
    if (quota.rateLimitsAvailable === false && windows.length === 0) {
      children.push(element('p', 'message', 'Pas de limite d’abonnement sur ce compte (clé API).'))
    } else if (windows.length === 0) {
      children.push(element('p', 'message', quota.error ? 'Limites illisibles : ' + quota.error : 'Pas encore de chiffres : ils arrivent avec la prochaine réponse de Claude, ou via ↻.'))
    }
    for (var index = 0; index < windows.length; index++) {
      var entry = windows[index]
      var gauge = element('div', 'gauge ' + LimitGauges.level(entry))
      var percent = entry.utilizationPercent
      gauge.appendChild(element('span', 'name', LimitGauges.shortLabel(entry.kind, entry.label)))
      gauge.appendChild(element('span', 'value', percent === null || percent === undefined ? '—' : Math.round(percent) + ' %'))
      var bar = element('div', 'bar')
      var fill = element('div', 'fill')
      fill.style.width = Math.max(0, Math.min(100, percent || 0)) + '%'
      bar.appendChild(fill)
      gauge.appendChild(bar)
      var resetText = LimitGauges.formatReset(entry.resetsAt, now)
      gauge.appendChild(element('span', 'reset', resetText ? 'Remise à zéro ' + resetText : entry.status === 'rejected' ? 'Limite atteinte' : 'Remise à zéro : heure non communiquée'))
      gauge.title = entry.label + ' — chiffre de Claude Code (' + (entry.source === 'usage_api' ? 'API d’usage' : 'réponse de Claude') + ', ' + LimitGauges.formatAgo(entry.observedAt, now) + ')'
      children.push(gauge)
    }
    gauges.replaceChildren.apply(gauges, children)
    seen.textContent = 'vu ' + LimitGauges.formatAgo(lastSeen(quota), now)
  }

  function apply(next) {
    if (next && Array.isArray(next.windows)) {
      quota = next
      render()
    }
  }

  function refresh() {
    refreshButton.disabled = true
    window.aether
      .call('quota.refresh')
      .then(apply)
      .catch(function (error) {
        gauges.replaceChildren(element('p', 'message', 'Limites illisibles : ' + error.message))
      })
      .finally(function () {
        refreshButton.disabled = false
      })
  }

  refreshButton.addEventListener('click', refresh)
  window.aether.on('quota', apply)
  window.aether.onContext(function (context) {
    document.body.classList.toggle('charcoal', !!context && context.theme === 'charcoal')
  })
  window.aether
    .call('quota.get')
    .then(function (current) {
      apply(current)
      // Ask Claude Code when the figures are old or missing.
      if (!current || Date.now() - lastSeen(current) > REFRESH_MS) refresh()
    })
    .catch(function () {
      refresh()
    })
  window.setInterval(refresh, REFRESH_MS)
  // The "in 2 h 14" texts move with time.
  window.setInterval(render, 30000)
})()
