import fs from 'fs'
import yargs from 'yargs'
import { app, shell, session, BrowserWindow } from 'electron'

import { ensureValidURL } from '../util'
import { pollPublicData, StreamIDGenerator } from './data'
import StreamWindow from './StreamWindow'
import initWebServer from './server'

async function main() {
  const argv = yargs
    .config('config', (configPath) => {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    })
    .group(
      ['webserver', 'cert-dir', 'cert-email', 'hostname', 'port'],
      'Web Server Configuration',
    )
    .option('webserver', {
      describe: 'Enable control webserver and specify the URL',
      implies: ['username', 'password'],
    })
    .option('hostname', {
      describe: 'Override hostname the control server listens on',
    })
    .option('port', {
      describe: 'Override port the control server listens on',
      number: true,
    })
    .option('cert-dir', {
      describe: 'Private directory to store SSL certificate in',
      implies: ['email'],
    })
    .option('cert-production', {
      describe: 'Obtain a real SSL certificate using production servers',
    })
    .option('email', {
      describe: 'Email for owner of SSL certificate',
    })
    .option('username', {
      describe: 'Web control server username',
    })
    .option('password', {
      describe: 'Web control server password',
    })
    .option('open', {
      describe: 'After launching, open the control website in a browser',
      boolean: true,
      default: true,
    })
    .option('background-color', {
      describe: 'Background color of wall (useful for chroma-keying)',
      default: '#000',
    })
    .help().argv

  // Reject all permission requests from web content.
  session
    .fromPartition('persist:session')
    .setPermissionRequestHandler((webContents, permission, callback) => {
      callback(false)
    })

  const idGen = new StreamIDGenerator()

  const streamWindow = new StreamWindow({
    backgroundColor: argv.backgroundColor,
  })
  streamWindow.init()

  let browseWindow = null

  const clientState = { streams: [], customStreams: [], views: [] }
  const getInitialState = () => clientState
  let broadcastState = () => {}
  const onMessage = (msg) => {
    if (msg.type === 'set-views') {
      streamWindow.setViews(new Map(msg.views))
    } else if (msg.type === 'set-listening-view') {
      streamWindow.setListeningView(msg.viewIdx)
    } else if (msg.type === 'set-view-blurred') {
      streamWindow.setViewBlurred(msg.viewIdx, msg.blurred)
    } else if (msg.type === 'set-custom-streams') {
      const customIDGen = new StreamIDGenerator(idGen)
      clientState.customStreams = customIDGen.process(msg.streams)
      streamWindow.send('state', clientState)
      broadcastState(clientState)
    } else if (msg.type === 'reload-view') {
      streamWindow.reloadView(msg.viewIdx)
    } else if (msg.type === 'browse' || msg.type === 'dev-tools') {
      if (
        msg.type === 'dev-tools' &&
        browseWindow &&
        !browseWindow.isDestroyed()
      ) {
        // DevTools needs a fresh webContents to work. Close any existing window.
        browseWindow.destroy()
        browseWindow = null
      }
      if (!browseWindow || browseWindow.isDestroyed()) {
        browseWindow = new BrowserWindow({
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            partition: 'persist:session',
            sandbox: true,
          },
        })
      }
      if (msg.type === 'browse') {
        ensureValidURL(msg.url)
        browseWindow.loadURL(msg.url)
      } else if (msg.type === 'dev-tools') {
        streamWindow.openDevTools(msg.viewIdx, browseWindow.webContents)
      }
    }
  }

  if (argv.webserver) {
    ;({ broadcastState } = await initWebServer({
      certDir: argv.certDir,
      certProduction: argv.certProduction,
      email: argv.email,
      url: argv.webserver,
      hostname: argv.hostname,
      port: argv.port,
      username: argv.username,
      password: argv.password,
      getInitialState,
      onMessage,
    }))
    if (argv.open) {
      shell.openExternal(argv.webserver)
    }
  }

  streamWindow.on('state', (viewStates) => {
    clientState.views = viewStates
    streamWindow.send('state', clientState)
    broadcastState(clientState)
  })

  for await (const rawStreams of pollPublicData()) {
    const streams = idGen.process(rawStreams)
    clientState.streams = streams
    streamWindow.send('state', clientState)
    broadcastState(clientState)
  }
}

if (require.main === module) {
  app
    .whenReady()
    .then(main)
    .catch((err) => {
      console.trace(err.toString())
      process.exit(1)
    })
}
