import check from 'check-more-types'
import Debug from 'debug'
import EE from 'events'
import _ from 'lodash'
import path from 'path'

import browsers from './browsers'
import pkg from '@packages/root'
import { RunnablesStore } from '@packages/reporter'
import { ServerCt, SocketCt } from '@packages/server-ct'
import { SocketE2E } from './socket-e2e'
import api from './api'
import { Automation } from './automation'
import config from './config'
import cwd from './cwd'
import errors from './errors'
import Reporter from './reporter'
import runEvents from './plugins/run_events'
import savedState from './saved_state'
import scaffold from './scaffold'
import { ServerE2E } from './server-e2e'
import system from './util/system'
import user from './user'
import { ensureProp } from './util/class-helpers'
import { escapeFilenameInUrl } from './util/escape_filename'
import { fs } from './util/fs'
import settings from './util/settings'
import plugins from './plugins'
import specsUtil from './util/specs'
import Watchers from './watchers'
import devServer from './plugins/dev-server'
import preprocessor from './plugins/preprocessor'
import { RunnerType, SpecsStore } from './specs-store'
import { createRoutes as createE2ERoutes } from './routes'
import { createRoutes as createCTRoutes } from '@packages/server-ct/src/routes-ct'

export type Cfg = Record<string, any>

type Options = Record<string, any>

const localCwd = cwd()
const multipleForwardSlashesRe = /[^:\/\/](\/{2,})/g
const backSlashesRe = /\\/g

const debug = Debug('cypress:server:project')
const debugScaffold = Debug('cypress:server:scaffold')

export class ProjectBase<TServer extends ServerE2E | ServerCt> extends EE {
  protected projectRoot: string
  protected watchers: Watchers
  protected options: Options
  protected _cfg?: Cfg
  protected _server?: TServer
  protected _automation?: Automation
  private _recordTests?: any = null

  public browser: any
  public projectType: RunnerType
  public spec: Cypress.Cypress['spec'] | null
  private generatedProjectIdTimestamp: any

  constructor ({
    projectRoot,
    projectType,
    options,
  }: {
    projectRoot: string
    projectType: RunnerType
    options: Options
  }) {
    super()

    if (!projectRoot) {
      throw new Error('Instantiating lib/project requires a projectRoot!')
    }

    if (!check.unemptyString(projectRoot)) {
      throw new Error(`Expected project root path, not ${projectRoot}`)
    }

    this.projectType = projectType
    this.projectRoot = path.resolve(projectRoot)
    this.watchers = new Watchers()
    this.spec = null
    this.browser = null

    debug('Project created %o', {
      projectType: this.projectType,
      projectRoot: this.projectRoot,
    })

    this.options = {
      report: false,
      onFocusTests () {},
      onError () {},
      onWarning () {},
      onSettingsChanged: false,
      ...options,
    }
  }

  protected ensureProp = ensureProp

  setOnTestsReceived (fn) {
    this._recordTests = fn
  }

  get server () {
    return this.ensureProp(this._server, 'open')
  }

  get automation () {
    return this.ensureProp(this._automation, 'open')
  }

  get cfg () {
    return this.ensureProp(this._cfg, 'open')
  }

  get state () {
    return this.cfg.state
  }

  injectCtSpecificConfig (cfg) {
    const rawJson = cfg.rawJson as Cfg

    return {
      ...cfg,
      viewportHeight: rawJson.viewportHeight ?? 500,
      viewportWidth: rawJson.viewportWidth ?? 500,
    }
  }

  createServer (projectType: RunnerType) {
    return projectType === 'e2e'
      ? new ServerE2E() as TServer
      : new ServerCt() as TServer
  }

  async onOpen (_cfg: Record<string, any> | undefined, options, server: TServer) {
    const cfgModdedByPlugins = await this._initPlugins(_cfg, options)
    const { cfg, specsStore, startSpecWatcher } = await this.initializeSpecStore(cfgModdedByPlugins)

    const updatedCfg = this.projectType === 'e2e'
      ? cfg
      : this.injectCtSpecificConfig(cfg)

    const [port, warning] = await server.open(updatedCfg, {
      project: this,
      onError: options.onError,
      onWarning: options.onWarning,
      shouldCorrelatePreRequests: this.shouldCorrelatePreRequests,
      projectType: this.projectType as 'ct' | 'e2e',
      SocketCtor: this.projectType === 'e2e' ? SocketE2E : SocketCt,
      createRoutes: this.projectType === 'e2e' ? createE2ERoutes : createCTRoutes,
      specsStore,
    })

    return {
      cfg: updatedCfg,
      port,
      warning,
      specsStore,
      startSpecWatcher,
    }
  }

  async open () {
    debug('opening project instance %s', this.projectRoot)
    debug('project open options %o', this.options)

    let cfg = await this.getConfig(this.options)

    process.chdir(this.projectRoot)

    // attach warning message if user has "chromeWebSecurity: false" for unsupported browser
    if (cfg.chromeWebSecurity === false) {
      _.chain(cfg.browsers)
      .filter((browser) => browser.family !== 'chromium')
      .each((browser) => browser.warning = errors.getMsgByType('CHROME_WEB_SECURITY_NOT_SUPPORTED', browser.name))
      .value()
    }

    // TODO: we currently always scaffold the plugins file
    // even when headlessly or else it will cause an error when
    // we try to load it and it's not there. We must do this here
    // else initialing the plugins will instantly fail.
    if (cfg.pluginsFile) {
      debug('scaffolding with plugins file %s', cfg.pluginsFile)

      await scaffold.plugins(path.dirname(cfg.pluginsFile), cfg)
    }

    this._server = this.createServer(this.projectType)
    const res = await this.onOpen(cfg, this.options, this._server)
    const { port, warning, startSpecWatcher } = res

    cfg = res.cfg

    // if we didnt have a cfg.port
    // then get the port once we
    // open the server
    if (!cfg.port) {
      cfg.port = port

      // and set all the urls again
      _.extend(cfg, config.setUrls(cfg))
    }

    cfg.proxyServer = cfg.proxyUrl

    // store the cfg from
    // opening the server
    this._cfg = cfg

    debug('project config: %o', _.omit(cfg, 'resolved'))

    if (warning) {
      this.options.onWarning(warning)
    }

    this.options.onSavedStateChanged = (state) => this.saveState(state)

    // save the last time they opened the project
    // along with the first time they opened it
    const now = Date.now()
    const stateToSave = {
      lastOpened: now,
    } as any

    if (!cfg.state || !cfg.state.firstOpened) {
      stateToSave.firstOpened = now
    }

    await Promise.all([
      this.watchSettingsAndStartWebsockets(this.options, cfg),
      this.scaffold(cfg),
      this.saveState(stateToSave),
    ])

    // start watching specs
    // whenever a spec file is added or removed, we notify the
    // <SpecList>
    // This is only used for CT right now, but it will be
    // used for E2E eventually. Until then, do not watch
    // the specs.
    startSpecWatcher()

    await Promise.all([
      this.checkSupportFile(cfg),
      this.watchPluginsFile(cfg, this.options),
    ])

    if (cfg.isTextTerminal || !cfg.experimentalInteractiveRunEvents) return

    const sys = await system.info()
    const beforeRunDetails = {
      config: cfg,
      cypressVersion: pkg.version,
      system: _.pick(sys, 'osName', 'osVersion'),
    }

    return runEvents.execute('before:run', cfg, beforeRunDetails)
  }

  async getRuns () {
    const [projectId, authToken] = await Promise.all([
      this.getProjectId(),
      user.ensureAuthToken(),
    ])

    return api.getProjectRuns(projectId, authToken)
  }

  reset () {
    debug('resetting project instance %s', this.projectRoot)

    this.spec = null
    this.browser = null

    if (this._automation) {
      this._automation.reset()
    }

    if (this._server) {
      return this._server.reset()
    }

    return
  }

  async close () {
    debug('closing project instance %s', this.projectRoot)

    this.spec = null
    this.browser = null

    const closePreprocessor = (this.projectType === 'e2e' && preprocessor.close) ?? undefined

    await Promise.all([
      this.server?.close(),
      this.watchers?.close(),
      closePreprocessor?.(),
    ])

    process.chdir(localCwd)

    const config = await this.getConfig()

    if (config.isTextTerminal || !config.experimentalInteractiveRunEvents) return

    return runEvents.execute('after:run', config)
  }

  async checkSupportFile (cfg) {
    const supportFile = cfg.supportFile

    if (supportFile) {
      const found = await fs.pathExists(supportFile)

      if (!found) {
        errors.throw('SUPPORT_FILE_NOT_FOUND', supportFile, settings.configFile(cfg))
      }
    }

    return
  }

  _onError<Options extends Record<string, any>> (err: Error, options: Options) {
    debug('got plugins error', err.stack)

    browsers.close()

    options.onError(err)
  }

  async initializeSpecStore (updatedConfig: Cfg) {
    if (this.projectType === 'ct') {
      updatedConfig.componentTesting = true

      // This value is normally set up in the `packages/server/lib/plugins/index.js#110`
      // But if we don't return it in the plugins function, it never gets set
      // Since there is no chance that it will have any other value here, we set it to "component"
      // This allows users to not return config in the `cypress/plugins/index.js` file
      // https://github.com/cypress-io/cypress/issues/16860
      updatedConfig.resolved.testingType = { value: 'component' }
    }

    debug('updated config: %o', updatedConfig)

    const allSpecs = await specsUtil.find(updatedConfig)
    const specs = allSpecs.filter((spec: Cypress.Cypress['spec']) => {
      if (this.projectType === 'ct') {
        return spec.specType === 'component'
      }

      if (this.projectType === 'e2e') {
        return spec.specType === 'integration'
      }

      throw Error(`Cannot return specType for projectType: ${this.projectType}`)
    })

    return this.initSpecStore({ specs, config: updatedConfig })
  }

  async _initPlugins (cfg, options) {
    // only init plugins with the
    // allowed config values to
    // prevent tampering with the
    // internals and breaking cypress
    const allowedCfg = config.allowed(cfg)

    const modifiedCfg = await plugins.init(allowedCfg, {
      projectRoot: this.projectRoot,
      configFile: settings.pathToConfigFile(this.projectRoot, options),
      testingType: options.testingType,
      onError: (err: Error) => this._onError(err, options),
      onWarning: options.onWarning,
    })

    debug('plugin config yielded: %o', modifiedCfg)

    return config.updateWithPluginValues(cfg, modifiedCfg)
  }

  async startCtDevServer (specs: Cypress.Cypress['spec'][], config: any) {
    // CT uses a dev-server to build the bundle.
    // We start the dev server here.
    const devServerOptions = await devServer.start({ specs, config })

    if (!devServerOptions) {
      throw new Error([
        'It looks like nothing was returned from on(\'dev-server:start\', {here}).',
        'Make sure that the dev-server:start function returns an object.',
        'For example: on("dev-server:start", () => startWebpackDevServer({ webpackConfig }))',
      ].join('\n'))
    }

    return { port: devServerOptions.port }
  }

  async initSpecStore ({
    specs,
    config,
  }: {
    specs: Cypress.Cypress['spec'][]
    config: any
  }) {
    const specsStore = new SpecsStore(config, this.projectType as RunnerType)

    if (this.projectType === 'ct') {
      const { port } = await this.startCtDevServer(specs, config)

      config.baseUrl = `http://localhost:${port}`
    }

    const startSpecWatcher = () => {
      return specsStore.watch({
        onSpecsChanged: (specs) => {
        // both e2e and CT watch the specs and send them to the
        // client to be shown in the SpecList.
          this.server.sendSpecList(specs, this.projectType as RunnerType)

          if (this.projectType === 'ct') {
          // ct uses the dev-server to build and bundle the speces.
          // send new files to dev server
            devServer.updateSpecs(specs)
          }
        },
      })
    }

    return specsStore.storeSpecFiles()
    .return({
      specsStore,
      cfg: config,
      startSpecWatcher,
    })
  }

  async watchPluginsFile (cfg, options) {
    debug(`attempt watch plugins file: ${cfg.pluginsFile}`)
    if (!cfg.pluginsFile || options.isTextTerminal) {
      return Promise.resolve()
    }

    const found = await fs.pathExists(cfg.pluginsFile)

    debug(`plugins file found? ${found}`)
    // ignore if not found. plugins#init will throw the right error
    if (!found) {
      return
    }

    debug('watch plugins file')

    return this.watchers.watchTree(cfg.pluginsFile, {
      onChange: () => {
        // TODO: completely re-open project instead?
        debug('plugins file changed')

        // re-init plugins after a change
        this._initPlugins(cfg, options)
        .catch((err) => {
          options.onError(err)
        })
      },
    })
  }

  watchSettings (onSettingsChanged, options) {
    // bail if we havent been told to
    // watch anything (like in run mode)
    if (!onSettingsChanged) {
      return
    }

    debug('watch settings files')

    const obj = {
      onChange: () => {
        // dont fire change events if we generated
        // a project id less than 1 second ago
        if (this.generatedProjectIdTimestamp &&
          ((Date.now() - this.generatedProjectIdTimestamp) < 1000)) {
          return
        }

        // call our callback function
        // when settings change!
        onSettingsChanged.call(this)
      },
    }

    if (options.configFile !== false) {
      this.watchers.watch(settings.pathToConfigFile(this.projectRoot, options), obj)
    }

    return this.watchers.watch(settings.pathToCypressEnvJson(this.projectRoot), obj)
  }

  watchSettingsAndStartWebsockets (options: Record<string, any> = {}, cfg: Record<string, any> = {}) {
    this.watchSettings(options.onSettingsChanged, options)

    const { projectRoot } = cfg
    let { reporter } = cfg as { reporter: RunnablesStore }

    // if we've passed down reporter
    // then record these via mocha reporter
    if (cfg.report) {
      try {
        Reporter.loadReporter(reporter, projectRoot)
      } catch (err) {
        const paths = Reporter.getSearchPathsForReporter(reporter, projectRoot)

        // only include the message if this is the standard MODULE_NOT_FOUND
        // else include the whole stack
        const errorMsg = err.code === 'MODULE_NOT_FOUND' ? err.message : err.stack

        errors.throw('INVALID_REPORTER_NAME', {
          paths,
          error: errorMsg,
          name: reporter,
        })
      }

      reporter = Reporter.create(reporter, cfg.reporterOptions, projectRoot)
    }

    const onBrowserPreRequest = (browserPreRequest) => {
      this.server.addBrowserPreRequest(browserPreRequest)
    }

    this._automation = new Automation(cfg.namespace, cfg.socketIoCookie, cfg.screenshotsFolder, onBrowserPreRequest)

    this.server.startWebsockets(this.automation, cfg, {
      onReloadBrowser: options.onReloadBrowser,

      onFocusTests: options.onFocusTests,

      onSpecChanged: options.onSpecChanged,

      onSavedStateChanged: options.onSavedStateChanged,

      onCaptureVideoFrames: (data) => {
        // TODO: move this to browser automation middleware
        this.emit('capture:video:frames', data)
      },

      onConnect: (id) => {
        debug('socket:connected')
        this.emit('socket:connected', id)
      },

      onTestsReceivedAndMaybeRecord: async (runnables, cb) => {
        debug('received runnables %o', runnables)

        if (reporter != null) {
          reporter.setRunnables(runnables)
        }

        if (this._recordTests) {
          await this._recordTests?.(runnables, cb)

          this._recordTests = null

          return
        }

        cb()
      },

      onMocha: async (event, runnable) => {
        debug('onMocha', event)
        // bail if we dont have a
        // reporter instance
        if (!reporter) {
          return
        }

        reporter.emit(event, runnable)

        if (event === 'end') {
          const [stats = {}] = await Promise.all([
            (reporter != null ? reporter.end() : undefined),
            this.server.end(),
          ])

          this.emit('end', stats)
        }

        return
      },
    })
  }

  changeToUrl (url) {
    this.server.changeToUrl(url)
  }

  shouldCorrelatePreRequests = () => {
    if (!this.browser) {
      return false
    }

    const { family, majorVersion } = this.browser

    return family === 'chromium' || (family === 'firefox' && majorVersion >= 86)
  }

  setCurrentSpecAndBrowser (spec, browser: Cypress.Browser) {
    this.spec = spec
    this.browser = browser
  }

  getCurrentSpecAndBrowser () {
    return {
      spec: this.spec,
      browser: this.browser,
    }
  }

  async setBrowsers (browsers = []) {
    debug('getting config before setting browsers %o', browsers)

    const cfg = await this.getConfig()

    debug('setting config browsers to %o', browsers)

    cfg.browsers = browsers
  }

  getAutomation () {
    return this.automation
  }

  removeScaffoldedFiles () {
    if (!this.cfg) {
      throw new Error('Missing project config')
    }

    return scaffold.removeIntegration(this.cfg.integrationFolder, this.cfg)
  }

  // do not check files again and again - keep previous promise
  // to refresh it - just close and open the project again.
  determineIsNewProject (folder) {
    return scaffold.isNewProject(folder)
  }

  // returns project config (user settings + defaults + cypress.json)
  // with additional object "state" which are transient things like
  // window width and height, DevTools open or not, etc.
  async getConfig (options: any = {}): Promise<Cfg> {
    if (options == null) {
      options = this.options
    }

    if (this._cfg) {
      debug('project has config %o', this._cfg)

      return Promise.resolve(this._cfg)
    }

    const setNewProject = async (cfg) => {
      if (cfg.isTextTerminal) {
        return
      }

      // decide if new project by asking scaffold
      // and looking at previously saved user state
      if (!cfg.integrationFolder) {
        throw new Error('Missing integration folder')
      }

      const untouchedScaffold = await this.determineIsNewProject(cfg)
      const userHasSeenBanner = _.get(cfg, 'state.showedNewProjectBanner', false)

      debugScaffold(`untouched scaffold ${untouchedScaffold} banner closed ${userHasSeenBanner}`)
      cfg.isNewProject = untouchedScaffold && !userHasSeenBanner
    }

    const theCfg = await config.get(this.projectRoot, options)

    await setNewProject(theCfg)

    const cfgWithSaved = await this._setSavedState(theCfg)

    return cfgWithSaved
  }

  // forces saving of project's state by first merging with argument
  async saveState (stateChanges = {}) {
    if (!this.cfg) {
      throw new Error('Missing project config')
    }

    if (!this.projectRoot) {
      throw new Error('Missing project root')
    }

    let state = await savedState.create(this.projectRoot, this.cfg.isTextTerminal)

    state.set(stateChanges)
    state = await state.get()
    this.cfg.state = state

    return state
  }

  async _setSavedState (cfg) {
    debug('get saved state')

    let state = await savedState.create(this.projectRoot, cfg.isTextTerminal)

    state = await state.get()
    cfg.state = state

    return cfg
  }

  async getSpecUrl (absoluteSpecPath, specType) {
    debug('get spec url: %s for spec type %s', absoluteSpecPath, specType)

    const cfg = await this.getConfig()

    // if we don't have a absoluteSpecPath or its __all
    if (!absoluteSpecPath || (absoluteSpecPath === '__all')) {
      const url = this.normalizeSpecUrl(cfg.browserUrl, '/__all')

      debug('returning url to run all specs: %s', url)

      return url
    }

    // TODO:
    // to handle both unit + integration tests we need
    // to figure out (based on the config) where this absoluteSpecPath
    // lives. does it live in the integrationFolder or
    // the unit folder?
    // once we determine that we can then prefix it correctly
    // with either integration or unit
    const prefixedPath = this.getPrefixedPathToSpec(cfg, absoluteSpecPath, specType)
    const url = this.normalizeSpecUrl(cfg.browserUrl, prefixedPath)

    debug('return path to spec %o', { specType, absoluteSpecPath, prefixedPath, url })

    return url
  }

  getPrefixedPathToSpec (cfg, pathToSpec, type = 'integration') {
    const { integrationFolder, componentFolder, projectRoot } = cfg

    // for now hard code the 'type' as integration
    // but in the future accept something different here

    // strip out the integration folder and prepend with "/"
    // example:
    //
    // /Users/bmann/Dev/cypress-app/.projects/cypress/integration
    // /Users/bmann/Dev/cypress-app/.projects/cypress/integration/foo.js
    //
    // becomes /integration/foo.js

    const folderToUse = type === 'integration' ? integrationFolder : componentFolder

    // To avoid having invalid urls from containing backslashes,
    // we normalize specUrls to posix by replacing backslash by slash
    // Indeed, path.realtive will return something different on windows
    // than on posix systems which can lead to problems
    const url = `/${path.join(type, path.relative(
      folderToUse,
      path.resolve(projectRoot, pathToSpec),
    )).replace(backSlashesRe, '/')}`

    debug('prefixed path for spec %o', { pathToSpec, type, url })

    return url
  }

  normalizeSpecUrl (browserUrl, specUrl) {
    const replacer = (match) => match.replace('//', '/')

    return [
      browserUrl,
      '#/tests',
      escapeFilenameInUrl(specUrl),
    ].join('/')
    .replace(multipleForwardSlashesRe, replacer)
  }

  scaffold (cfg: Cfg) {
    debug('scaffolding project %s', this.projectRoot)

    const scaffolds = []

    const push = scaffolds.push.bind(scaffolds) as any

    // TODO: we are currently always scaffolding support
    // even when headlessly - this is due to a major breaking
    // change of 0.18.0
    // we can later force this not to always happen when most
    // of our users go beyond 0.18.0
    //
    // ensure support dir is created
    // and example support file if dir doesnt exist
    push(scaffold.support(cfg.supportFolder, cfg))

    // if we're in headed mode add these other scaffolding tasks
    debug('scaffold flags %o', {
      isTextTerminal: cfg.isTextTerminal,
      CYPRESS_INTERNAL_FORCE_SCAFFOLD: process.env.CYPRESS_INTERNAL_FORCE_SCAFFOLD,
    })

    const scaffoldExamples = !cfg.isTextTerminal || process.env.CYPRESS_INTERNAL_FORCE_SCAFFOLD

    if (scaffoldExamples) {
      debug('will scaffold integration and fixtures folder')
      push(scaffold.integration(cfg.integrationFolder, cfg))
      push(scaffold.fixture(cfg.fixturesFolder, cfg))
    } else {
      debug('will not scaffold integration or fixtures folder')
    }

    return Promise.all(scaffolds)
  }

  async getProjectId () {
    await this.verifyExistence()
    const readSettings = await settings.read(this.projectRoot, this.options)

    if (readSettings && readSettings.projectId) {
      return readSettings.projectId
    }

    errors.throw('NO_PROJECT_ID', settings.configFile(this.options), this.projectRoot)
  }

  async verifyExistence () {
    try {
      await fs.statAsync(this.projectRoot)
    } catch (err) {
      errors.throw('NO_PROJECT_FOUND_AT_PROJECT_ROOT', this.projectRoot)
    }
  }

  async getRecordKeys () {
    const [projectId, authToken] = await Promise.all([
      this.getProjectId(),
      user.ensureAuthToken(),
    ])

    return api.getProjectRecordKeys(projectId, authToken)
  }

  async requestAccess (projectId) {
    const authToken = await user.ensureAuthToken()

    return api.requestAccess(projectId, authToken)
  }

  // For testing
  // Do not use this method outside of testing
  // pass all your options when you create a new instance!
  __setOptions (options: Options) {
    this.options = options
  }
}
