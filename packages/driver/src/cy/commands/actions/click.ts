import _ from 'lodash'
import $ from 'jquery'
import Promise from 'bluebird'
import $dom from '../../../dom'
import $utils from '../../../cypress/utils'
import $errUtils from '../../../cypress/error_utils'
import $actionability from '../../actionability'

const formatMouseEvents = (events) => {
  return _.map(events, (val, key) => {
    // get event type either from the keyname, or from the sole object key name
    const eventName = (typeof key === 'string') ? key : val.type

    if (val.skipped) {
      const reason = val.skipped

      return {
        'Event Type': eventName,
        'Target Element': reason,
        'Prevented Default': null,
        'Stopped Propagation': null,
        'Active Modifiers': null,
      }
    }

    return {
      'Event Type': eventName,
      'Target Element': val.el,
      'Prevented Default': val.preventedDefault || null,
      'Stopped Propagation': val.stoppedPropagation || null,
      'Active Modifiers': val.modifiers || null,
    }
  })
}

export default (Commands, Cypress, cy, state, config) => {
  const { mouse, keyboard } = cy.devices

  const mouseAction = (eventName, { subject, positionOrX, y, userOptions, onReady, onTable, defaultOptions }) => {
    let position
    let x

    ({ options: userOptions, position, x, y } = $actionability.getPositionFromArguments(positionOrX, y, userOptions))

    const options = _.defaults({}, userOptions, {
      $el: subject,
      log: true,
      verify: true,
      force: false,
      multiple: false,
      position,
      x,
      y,
      errorOnSelect: true,
      waitForAnimations: config('waitForAnimations'),
      animationDistanceThreshold: config('animationDistanceThreshold'),
      scrollBehavior: config('scrollBehavior'),
      ctrlKey: false,
      controlKey: false,
      altKey: false,
      optionKey: false,
      shiftKey: false,
      metaKey: false,
      commandKey: false,
      cmdKey: false,
      ...defaultOptions,
    })

    // throw if we're trying to click multiple elements
    // and we did not pass the multiple flag
    if ((options.multiple === false) && (options.$el.length > 1)) {
      $errUtils.throwErrByPath('click.multiple_elements', {
        args: { cmd: eventName, num: options.$el.length },
      })
    }

    const flagModifiers = (press) => {
      if (options.ctrlKey || options.controlKey) {
        keyboard.flagModifier({ key: 'Control' }, press)
      }

      if (options.altKey || options.optionKey) {
        keyboard.flagModifier({ key: 'Alt' }, press)
      }

      if (options.shiftKey) {
        keyboard.flagModifier({ key: 'Shift' }, press)
      }

      if (options.metaKey || options.commandKey || options.cmdKey) {
        keyboard.flagModifier({ key: 'Meta' }, press)
      }
    }

    const perform = (el) => {
      let deltaOptions
      const $el = $dom.wrap(el)

      if (options.log) {
        // figure out the options which actually change the behavior of clicks
        deltaOptions = $utils.filterOutOptions(options, defaultOptions)

        options._log = Cypress.log({
          message: deltaOptions,
          $el,
          timeout: options.timeout,
        })

        options._log.snapshot('before', { next: 'after' })
      }

      if (options.errorOnSelect && $el.is('select')) {
        $errUtils.throwErrByPath('click.on_select_element', {
          args: { cmd: eventName },
          onFail: options._log,
        })
      }

      // add this delay delta to the runnables timeout because we delay
      // by it below before performing each click
      cy.timeout($actionability.delay, true, eventName)

      const createLog = (domEvents, fromElWindow, fromAutWindow) => {
        let consoleObj

        const elClicked = domEvents.moveEvents.el

        if (options._log) {
          consoleObj = options._log.invoke('consoleProps')
        }

        const consoleProps = function () {
          consoleObj = _.defaults(consoleObj != null ? consoleObj : {}, {
            'Applied To': $dom.getElements(options.$el),
            'Elements': options.$el.length,
            'Coords': _.pick(fromElWindow, 'x', 'y'), // always absolute
            'Options': deltaOptions,
          })

          if (options.$el.get(0) !== elClicked) {
            // only do this if $elToClick isnt $el
            consoleObj['Actual Element Clicked'] = $dom.getElements($(elClicked))
          }

          consoleObj.table = _.extend((consoleObj.table || {}), onTable(domEvents))

          return consoleObj
        }

        return Promise
        .delay($actionability.delay, 'click')
        .then(() => {
          // display the red dot at these coords
          if (options._log) {
            // because we snapshot and output a command per click
            // we need to manually snapshot + end them
            options._log.set({ coords: fromAutWindow, consoleProps })
          }

          // we need to split this up because we want the coordinates
          // to mutate our passed in options._log but we dont necessary
          // want to snapshot and end our command if we're a different
          // action like (cy.type) and we're borrowing the click action
          if (options._log && options.log) {
            return options._log.snapshot().end()
          }
        })
        .return(null)
      }

      // if { multiple: true }, make a shallow copy of options, since
      // properties like `total` and `_retries` are mutated by
      // $actionability.verify and retrying, but each click should
      // have its own full timeout
      const individualOptions = { ... options }

      // must use callbacks here instead of .then()
      // because we're issuing the clicks synchronously
      // once we establish the coordinates and the element
      // passes all of the internal checks
      return $actionability.verify(cy, $el, individualOptions, {
        onScroll ($el, type) {
          return Cypress.action('cy:scrolled', $el, type)
        },

        onReady ($elToClick, coords) {
          const { fromElViewport, fromElWindow, fromAutWindow } = coords

          const forceEl = options.force && $elToClick.get(0)

          const moveEvents = mouse.move(fromElViewport, forceEl)

          flagModifiers(true)

          const onReadyProps = onReady(fromElViewport, forceEl)

          flagModifiers(false)

          return createLog({
            moveEvents,
            ...onReadyProps,
          },
          fromElWindow,
          fromAutWindow)
        },
      })
      .catch((err) => {
        // snapshot only on click failure
        err.onFail = function () {
          if (options._log) {
            return options._log.snapshot()
          }
        }

        // if we give up on waiting for actionability then
        // lets throw this error and log the command
        return $errUtils.throwErr(err, { onFail: options._log })
      })
    }

    return Promise
    .each(options.$el.toArray(), perform)
    .then(() => {
      if (options.verify === false) {
        return options.$el
      }

      const verifyAssertions = () => {
        return cy.verifyUpcomingAssertions(options.$el, options, {
          onRetry: verifyAssertions,
        })
      }

      return verifyAssertions()
    })
  }

  return Commands.addAll({ prevSubject: 'element' }, {
    click (subject, positionOrX, y, options = {}) {
      return mouseAction('click', {
        y,
        subject,
        userOptions: options,
        positionOrX,
        onReady (fromElViewport, forceEl) {
          const clickEvents = mouse.click(fromElViewport, forceEl)

          return {
            clickEvents,
          }
        },
        onTable (domEvents) {
          return {
            1: () => {
              return {
                name: 'Mouse Events',
                data: _.concat(
                  formatMouseEvents(domEvents.moveEvents.events),
                  formatMouseEvents(domEvents.clickEvents),
                ),
              }
            },
          }
        },
      })
    },

    dblclick (subject, positionOrX, y, options = {}) {
      return mouseAction('dblclick', {
        y,
        subject,
        userOptions: options,
        // TODO: 4.0 make this false by default
        defaultOptions: { multiple: true },
        positionOrX,
        onReady (fromElViewport, forceEl) {
          const { clickEvents1, clickEvents2, dblclick } = mouse.dblclick(fromElViewport, forceEl)

          return {
            dblclick,
            clickEvents: [clickEvents1, clickEvents2],
          }
        },
        onTable (domEvents) {
          return {
            1: () => {
              return {
                name: 'Mouse Events',
                data: _.concat(
                  formatMouseEvents(domEvents.moveEvents.events),
                  formatMouseEvents(domEvents.clickEvents[0]),
                  formatMouseEvents(domEvents.clickEvents[1]),
                  formatMouseEvents({
                    dblclick: domEvents.dblclick,
                  }),
                ),
              }
            },
          }
        },
      })
    },

    rightclick (subject, positionOrX, y, options = {}) {
      return mouseAction('rightclick', {
        y,
        subject,
        userOptions: options,
        positionOrX,
        onReady (fromElViewport, forceEl) {
          const { clickEvents, contextmenuEvent } = mouse.rightclick(fromElViewport, forceEl)

          return {
            clickEvents,
            contextmenuEvent,
          }
        },
        onTable (domEvents) {
          return {
            1: () => {
              return {
                name: 'Mouse Events',
                data: _.concat(
                  formatMouseEvents(domEvents.moveEvents.events),
                  formatMouseEvents(domEvents.clickEvents),
                  formatMouseEvents(domEvents.contextmenuEvent),
                ),
              }
            },

          }
        },
      })
    },
  })
}
