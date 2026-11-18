/*
 * Aether mod bridge. Include it in a panel page:
 *   <script src="aether-mod://sdk/aether-mod.js"></script>
 *
 *   const context = await aether.context()             // active conversation, theme
 *   aether.onContext((context) => { ... })             // called when the user switches conversation
 *   const graph = await aether.call('git.log', { limit: 200 })   // needs "git.read"
 *   aether.call('ui.toast', { text: 'Bonjour' })                 // needs "ui.toast"
 *   const usage = await aether.call('usage.get')                 // needs "usage.read": { now, samples }
 *   aether.on('usage', (sample) => { ... })                      // each new token sample, live
 *   const recent = await aether.call('events.recent', { limit: 100 })   // needs "events.read"
 *   aether.on('events', (event) => { ... })   // tours, modèle, outils, erreurs : jamais le contenu
 *   const list = await aether.call('conversations.list')         // needs "context.read"
 *   aether.call('composer.insert', { text, replace: false })     // needs "composer.write"
 *   aether.call('panel.open', { panel: 'terminal' })             // needs "panels.open" (ses panneaux, terminal, chatgpt, pilot)
 *   aether.call('command.run', { text: '/compact' })             // needs "commands.run", confirmé par l'utilisateur
 *   aether.call('orion.status')                                  // needs "orion.connect" (ORION CONNECT) :
 *   aether.call('orion.request', { method: 'GET', path: 'apps' })   // routes clientes d'ORION APPS seulement
 *
 * Files of a mod in the user mods folder reload by themselves when they change on disk.
 *
 * The panel runs in a sandbox: no network, no Node.js, nothing outside its own folder.
 */
/* global window, console, setTimeout */
;(function () {
  'use strict'
  var TAG = 'aether-mod-bridge'
  var nextRequestId = 1
  var pending = new Map()
  var contextListeners = []
  var eventListeners = new Map()
  var lastContext = null

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return
    var message = event.data
    if (!message || message.tag !== TAG) return
    if (message.event === 'context') {
      lastContext = message.data
      contextListeners.forEach(function (listener) {
        try {
          listener(message.data)
        } catch (error) {
          console.error(error)
        }
      })
      return
    }
    if (typeof message.event === 'string') {
      ;(eventListeners.get(message.event) || []).forEach(function (listener) {
        try {
          listener(message.data)
        } catch (error) {
          console.error(error)
        }
      })
      return
    }
    var request = pending.get(message.requestId)
    if (!request) return
    pending.delete(message.requestId)
    if (message.ok) request.resolve(message.result)
    else request.reject(new Error(message.error || 'Erreur inconnue'))
  })

  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var requestId = nextRequestId++
      pending.set(requestId, { resolve: resolve, reject: reject })
      window.parent.postMessage({ tag: TAG, requestId: requestId, method: method, params: params || {} }, '*')
      setTimeout(function () {
        if (pending.delete(requestId)) reject(new Error('Aether n’a pas répondu.'))
      }, 30000)
    })
  }

  window.aether = Object.freeze({
    call: call,
    context: function () {
      return lastContext ? Promise.resolve(lastContext) : call('context.get')
    },
    on: function (name, listener) {
      eventListeners.set(name, (eventListeners.get(name) || []).concat([listener]))
      return function () {
        eventListeners.set(
          name,
          (eventListeners.get(name) || []).filter(function (item) {
            return item !== listener
          })
        )
      }
    },
    onContext: function (listener) {
      contextListeners.push(listener)
      return function () {
        contextListeners = contextListeners.filter(function (item) {
          return item !== listener
        })
      }
    }
  })
})()
