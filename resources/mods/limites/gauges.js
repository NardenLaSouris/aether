/*
 * Limites Claude: what the gauges show, from the figures Claude Code reported (pure, tested).
 */
/* global self, module */
;(function (root) {
  'use strict'

  var ORDER = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_overage_included', 'overage']
  var SHORT = { five_hour: 'Session (5 h)', seven_day: 'Semaine', seven_day_opus: 'Semaine Opus', seven_day_sonnet: 'Semaine Sonnet', seven_day_overage_included: 'Semaine + extra', overage: 'Usage extra' }

  /** The windows worth a gauge, in a stable order: session, week, then the per-model weeks. */
  function gaugeWindows(windows) {
    var byKind = {}
    for (var index = 0; index < (windows || []).length; index++) {
      var entry = windows[index]
      if (ORDER.indexOf(entry.kind) < 0) continue
      // Keep the most recent figure of each kind.
      if (!byKind[entry.kind] || entry.observedAt > byKind[entry.kind].observedAt) byKind[entry.kind] = entry
    }
    var list = []
    for (var position = 0; position < ORDER.length; position++) if (byKind[ORDER[position]]) list.push(byKind[ORDER[position]])
    return list
  }

  function shortLabel(kind, fallback) {
    return SHORT[kind] || fallback || kind
  }

  /** calm < 70 % ≤ warm < 90 % ≤ hot; a rejected window is hot whatever its figure. */
  function level(entry) {
    if (entry.status === 'rejected') return 'hot'
    var percent = entry.utilizationPercent
    if (percent === null || percent === undefined) return entry.status === 'allowed_warning' ? 'warm' : 'unknown'
    if (percent >= 90) return 'hot'
    if (percent >= 70 || entry.status === 'allowed_warning') return 'warm'
    return 'calm'
  }

  function pad(value) {
    return value < 10 ? '0' + value : String(value)
  }

  /** "dans 2 h 14 (16:30)", "dans 3 j (lun. 09:00)", or null when unknown or past. */
  function formatReset(resetsAt, now) {
    if (!resetsAt || resetsAt <= now) return null
    var minutes = Math.round((resetsAt - now) / 60000)
    var date = new Date(resetsAt)
    var clock = pad(date.getHours()) + ':' + pad(date.getMinutes())
    if (minutes < 60) return 'dans ' + Math.max(1, minutes) + ' min (' + clock + ')'
    if (minutes < 24 * 60) return 'dans ' + Math.floor(minutes / 60) + ' h ' + pad(minutes % 60) + ' (' + clock + ')'
    var days = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.']
    return 'dans ' + Math.round(minutes / (24 * 60)) + ' j (' + days[date.getDay()] + ' ' + clock + ')'
  }

  /** "à l’instant", "il y a 4 min", "il y a 2 h". */
  function formatAgo(at, now) {
    if (!at) return 'jamais'
    var minutes = Math.floor((now - at) / 60000)
    if (minutes < 1) return 'à l’instant'
    if (minutes < 60) return 'il y a ' + minutes + ' min'
    return 'il y a ' + Math.floor(minutes / 60) + ' h'
  }

  var api = { gaugeWindows: gaugeWindows, shortLabel: shortLabel, level: level, formatReset: formatReset, formatAgo: formatAgo }
  root.LimitGauges = api
  if (typeof module === 'object' && module && module.exports) module.exports = api
})(typeof self !== 'undefined' ? self : globalThis)
