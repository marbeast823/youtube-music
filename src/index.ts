import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';

import {
  BrowserWindow,
  app,
  screen,
  globalShortcut,
  session,
  shell,
  dialog,
  ipcMain,
} from 'electron';
import enhanceWebRequest, {
  BetterSession,
} from '@jellybrick/electron-better-web-request';
import is from 'electron-is';
import unhandled from 'electron-unhandled';
import { autoUpdater } from 'electron-updater';
import electronDebug from 'electron-debug';
import { parse } from 'node-html-parser';
import { deepmerge } from 'deepmerge-ts';
import { deepEqual } from 'fast-equals';

import { allPlugins, mainPlugins } from 'virtual:plugins';

import { languageResources } from 'virtual:i18n';

import config from '@/config';

import { refreshMenu, setApplicationMenu } from '@/menu';
import { fileExists, injectCSS, injectCSSAsFile } from '@/plugins/utils/main';
import { isTesting } from '@/utils/testing';
import { setUpTray } from '@/tray';
import { setupSongInfo } from '@/providers/song-info';
import { restart, setupAppControls } from '@/providers/app-controls';
import {
  APP_PROTOCOL,
  handleProtocol,
  setupProtocolHandler,
} from '@/providers/protocol-handler';

import youtubeMusicCSS from '@/youtube-music.css?inline';

import {
  forceLoadMainPlugin,
  forceUnloadMainPlugin,
  getAllLoadedMainPlugins,
  loadAllMainPlugins,
} from '@/loader/main';

import { LoggerPrefix } from '@/utils';
import { loadI18n, setLanguage, t } from '@/i18n';

import type { PluginConfig } from '@/types/plugins';

// Catch errors and log them
unhandled({
  logger: console.error,
  showDialog: false,
});

// Disable Node options if the env var is set
process.env.NODE_OPTIONS = '';

// Prevent window being garbage collected
let mainWindow: Electron.BrowserWindow | null;
autoUpdater.autoDownload = false;

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.exit();
}

// SharedArrayBuffer: Required for downloader (@ffmpeg/core-mt)
// OverlayScrollbar: Required for overlay scrollbars
app.commandLine.appendSwitch(
  'enable-features',
  'OverlayScrollbar,SharedArrayBuffer',
);
if (config.get('options.disableHardwareAcceleration')) {
  if (is.dev()) {
    console.log('Disabling hardware acceleration');
  }

  app.disableHardwareAcceleration();
}

if (is.linux() && config.plugins.isEnabled('shortcuts')) {
  // Stops chromium from launching its own MPRIS service
  app.commandLine.appendSwitch('disable-features', 'MediaSessionService');
}

if (config.get('options.proxy')) {
  app.commandLine.appendSwitch('proxy-server', config.get('options.proxy'));
}

// Adds debug features like hotkeys for triggering dev tools and reload
electronDebug({
  showDevTools: false, // Disable automatic devTools on new window
});

let icon = 'assets/youtube-music.png';
if (process.platform === 'win32') {
  icon = 'assets/generated/icon.ico';
} else if (process.platform === 'darwin') {
  icon = 'assets/generated/icon.icns';
}

function onClosed() {
  // Dereference the window
  // For multiple Windows store them in an array
  mainWindow = null;
}

ipcMain.handle('get-main-plugin-names', () => Object.keys(mainPlugins));

const initHook = (win: BrowserWindow) => {
  ipcMain.handle(
    'get-config',
    (_, id: string) =>
      deepmerge(
        allPlugins[id].config ?? { enabled: false },
        config.get(`plugins.${id}`) ?? {},
      ) as PluginConfig,
  );
  ipcMain.handle('set-config', (_, name: string, obj: object) =>
    config.setPartial(`plugins.${name}`, obj, allPlugins[name].config),
  );

  config.watch((newValue, oldValue) => {
    const newPluginConfigList = (newValue?.plugins ?? {}) as Record<
      string,
      unknown
    >;
    const oldPluginConfigList = (oldValue?.plugins ?? {}) as Record<
      string,
      unknown
    >;

    Object.entries(newPluginConfigList).forEach(([id, newPluginConfig]) => {
      const isEqual = deepEqual(oldPluginConfigList[id], newPluginConfig);

      if (!isEqual) {
        const oldConfig = oldPluginConfigList[id] as PluginConfig;
        const config = deepmerge(
          allPlugins[id].config ?? { enabled: false },
          newPluginConfig ?? {},
        ) as PluginConfig;

        if (config.enabled !== oldConfig?.enabled) {
          if (config.enabled) {
            win.webContents.send('plugin:enable', id);
            ipcMain.emit('plugin:enable', id);
            forceLoadMainPlugin(id, win);
          } else {
            win.webContents.send('plugin:unload', id);
            ipcMain.emit('plugin:unload', id);
            forceUnloadMainPlugin(id, win);
          }

          if (allPlugins[id]?.restartNeeded) {
            showNeedToRestartDialog(id);
          }
        }

        const mainPlugin = getAllLoadedMainPlugins()[id];
        if (mainPlugin) {
          if (config.enabled && typeof mainPlugin.backend !== 'function') {
            mainPlugin.backend?.onConfigChange?.call(
              mainPlugin.backend,
              config,
            );
          }
        }

        win.webContents.send('config-changed', id, config);
      }
    });
  });
};

const showNeedToRestartDialog = (id: string) => {
  const plugin = allPlugins[id];

  const dialogOptions: Electron.MessageBoxOptions = {
    type: 'info',
    buttons: [
      t('main.dialog.need-to-restart.buttons.restart-now'),
      t('main.dialog.need-to-restart.buttons.later'),
    ],
    title: t('main.dialog.need-to-restart.title'),
    message: t('main.dialog.need-to-restart.message', {
      pluginName: plugin?.name?.() ?? id,
    }),
    detail: t('main.dialog.need-to-restart.detail', {
      pluginName: plugin?.name?.() ?? id,
    }),
    defaultId: 0,
    cancelId: 1,
  };

  let dialogPromise: Promise<Electron.MessageBoxReturnValue>;
  if (mainWindow) {
    dialogPromise = dialog.showMessageBox(mainWindow, dialogOptions);
  } else {
    dialogPromise = dialog.showMessageBox(dialogOptions);
  }

  dialogPromise.then((dialogOutput) => {
    switch (dialogOutput.response) {
      case 0: {
        restart();
        break;
      }

      // Ignore
      default: {
        break;
      }
    }
  });
};

function initTheme(win: BrowserWindow) {
  injectCSS(win.webContents, youtubeMusicCSS);
  // Load user CSS
  const themes: string[] = config.get('options.themes');
  if (Array.isArray(themes)) {
    for (const cssFile of themes) {
      fileExists(
        cssFile,
        () => {
          injectCSSAsFile(win.webContents, cssFile);
        },
        () => {
          console.warn(
            LoggerPrefix,
            t('main.console.theme.css-file-not-found', { cssFile }),
          );
        },
      );
    }
  }

  win.webContents.once('did-finish-load', () => {
    if (is.dev()) {
      console.debug(LoggerPrefix, t('main.console.did-finish-load.dev-tools'));
      win.webContents.openDevTools();
    }
  });
}

async function createMainWindow() {
  const windowSize = config.get('window-size');
  const windowMaximized = config.get('window-maximized');
  const windowPosition: Electron.Point = config.get('window-position');
  const useInlineMenu = config.plugins.isEnabled('in-app-menu');

  const defaultTitleBarOverlayOptions: Electron.TitleBarOverlayOptions = {
    color: '#00000000',
    symbolColor: '#ffffff',
    height: 32,
  };

  const win = new BrowserWindow({
    icon,
    width: windowSize.width,
    height: windowSize.height,
    backgroundColor: '#000',
    show: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      ...(isTesting()
        ? undefined
        : {
            // Sandbox is only enabled in tests for now
            // See https://www.electronjs.org/docs/latest/tutorial/sandbox#preload-scripts
            sandbox: false,
          }),
    },
    frame: !is.macOS() && !useInlineMenu,
    titleBarOverlay: defaultTitleBarOverlayOptions,
    titleBarStyle: useInlineMenu
      ? 'hidden'
      : is.macOS()
      ? 'hiddenInset'
      : 'default',
    autoHideMenuBar: config.get('options.hideMenu'),
  });
  initHook(win);
  initTheme(win);

  await loadAllMainPlugins(win);

  if (windowPosition) {
    const { x: windowX, y: windowY } = windowPosition;
    const winSize = win.getSize();
    const display = screen.getDisplayNearestPoint(windowPosition);
    const scaleFactor = display.scaleFactor;

    const scaledWidth = Math.floor(windowSize.width / scaleFactor);
    const scaledHeight = Math.floor(windowSize.height / scaleFactor);

    const scaledX = windowX;
    const scaledY = windowY;

    if (
      scaledX + scaledWidth < display.bounds.x - 8 ||
      scaledX - scaledWidth > display.bounds.x + display.bounds.width ||
      scaledY < display.bounds.y - 8 ||
      scaledY > display.bounds.y + display.bounds.height
    ) {
      // Window is offscreen
      if (is.dev()) {
        console.warn(
          LoggerPrefix,
          t('main.console.window.tried-to-render-offscreen', {
            winSize: String(winSize),
            displaySize: String(display.bounds),
            windowPosition: String(windowPosition),
          }),
        );
      }
    } else {
      win.setSize(scaledWidth, scaledHeight);
      win.setPosition(scaledX, scaledY);
    }
  }

  if (windowMaximized) {
    win.maximize();
  }

  if (config.get('options.alwaysOnTop')) {
    win.setAlwaysOnTop(true);
  }

  const urlToLoad = config.get('options.resumeOnStart')
    ? config.get('url')
    : config.defaultConfig.url;
  win.on('closed', onClosed);

  win.on('move', () => {
    if (win.isMaximized()) {
      return;
    }

    const [x, y] = win.getPosition();
    lateSave('window-position', { x, y });
  });

  let winWasMaximized: boolean;

  win.on('resize', () => {
    const [width, height] = win.getSize();
    const isMaximized = win.isMaximized();

    if (winWasMaximized !== isMaximized) {
      winWasMaximized = isMaximized;
      config.set('window-maximized', isMaximized);
    }

    if (isMaximized) {
      return;
    }

    lateSave('window-size', {
      width,
      height,
    });
  });

  const savedTimeouts: Record<string, NodeJS.Timeout | undefined> = {};

  function lateSave(
    key: string,
    value: unknown,
    fn: (key: string, value: unknown) => void = config.set,
  ) {
    if (savedTimeouts[key]) {
      clearTimeout(savedTimeouts[key]);
    }

    savedTimeouts[key] = setTimeout(() => {
      fn(key, value);
      savedTimeouts[key] = undefined;
    }, 600);
  }

  app.on('render-process-gone', (_event, _webContents, details) => {
    showUnresponsiveDialog(win, details);
  });

  win.once('ready-to-show', () => {
    if (config.get('options.appVisible')) {
      win.show();
    }
  });

  removeContentSecurityPolicy();

  win.webContents.on('dom-ready', async () => {
    if (useInlineMenu && !is.linux()) {
      win.setTitleBarOverlay({
        ...defaultTitleBarOverlayOptions,
        height: Math.floor(
          defaultTitleBarOverlayOptions.height! *
            win.webContents.getZoomFactor(),
        ),
      });
    }

    // Inject index.html file as string using insertAdjacentHTML
    // In dev mode, get string from process.env.VITE_DEV_SERVER_URL, else use fs.readFileSync
    if (is.dev() && process.env.ELECTRON_RENDERER_URL) {
      // HACK: to make vite work with electron renderer (supports hot reload)
      await win.webContents.executeJavaScript(`
        console.log('Loading vite from dev server');
        const viteScript = document.createElement('script');
        viteScript.type = 'module';
        viteScript.src = '${process.env.ELECTRON_RENDERER_URL}/@vite/client';
        const rendererScript = document.createElement('script');
        rendererScript.type = 'module';
        rendererScript.src = '${process.env.ELECTRON_RENDERER_URL}/renderer.ts';
        document.body.appendChild(viteScript);
        document.body.appendChild(rendererScript);
        0
      `);
    } else {
      const rendererPath = path.join(__dirname, '..', 'renderer');
      const indexHTML = parse(
        fs.readFileSync(path.join(rendererPath, 'index.html'), 'utf-8'),
      );
      const scriptSrc = indexHTML.querySelector('script')!;
      const scriptPath = path.join(
        rendererPath,
        scriptSrc.getAttribute('src')!,
      );
      const scriptString = fs.readFileSync(scriptPath, 'utf-8');
      await win.webContents.executeJavaScriptInIsolatedWorld(
        0,
        [
          {
            code: scriptString + ';0',
            url: url.pathToFileURL(scriptPath).toString(),
          },
        ],
        true,
      );
    }
  });

  win.webContents.loadURL(urlToLoad);

  return win;
}

app.once('browser-window-created', (_event, win) => {
  if (config.get('options.overrideUserAgent')) {
    // User agents are from https://developers.whatismybrowser.com/useragents/explore/
    const originalUserAgent = win.webContents.userAgent;
    const userAgents = {
      mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 12.1; rv:95.0) Gecko/20100101 Firefox/95.0',
      windows:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:95.0) Gecko/20100101 Firefox/95.0',
      linux: 'Mozilla/5.0 (Linux x86_64; rv:95.0) Gecko/20100101 Firefox/95.0',
    };

    const updatedUserAgent = is.macOS()
      ? userAgents.mac
      : is.windows()
      ? userAgents.windows
      : userAgents.linux;

    win.webContents.userAgent = updatedUserAgent;
    app.userAgentFallback = updatedUserAgent;

    win.webContents.session.webRequest.onBeforeSendHeaders((details, cb) => {
      // This will only happen if login failed, and "retry" was pressed
      if (
        win.webContents.getURL().startsWith('https://accounts.google.com') &&
        details.url.startsWith('https://accounts.google.com')
      ) {
        details.requestHeaders['User-Agent'] = originalUserAgent;
      }

      cb({ requestHeaders: details.requestHeaders });
    });
  }

  setupSongInfo(win);
  setupAppControls();

  win.webContents.on(
    'did-fail-load',
    (
      _event,
      errorCode,
      errorDescription,
      validatedURL,
      isMainFrame,
      frameProcessId,
      frameRoutingId,
    ) => {
      const log = JSON.stringify(
        {
          error: 'did-fail-load',
          errorCode,
          errorDescription,
          validatedURL,
          isMainFrame,
          frameProcessId,
          frameRoutingId,
        },
        null,
        '\t',
      );
      if (is.dev()) {
        console.log(log);
      }

      if (errorCode !== -3) {
        // -3 is a false positive
        win.webContents.send('log', log);
        win.webContents.loadFile(path.join(__dirname, 'error.html'));
      }
    },
  );

  win.webContents.on('will-prevent-unload', (event) => {
    event.preventDefault();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }

  // Unregister all shortcuts.
  globalShortcut.unregisterAll();
});

app.on('activate', async () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (mainWindow === null) {
    mainWindow = await createMainWindow();
  } else if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
});

const getDefaultLocale = (locale: string) =>
  Object.keys(languageResources).includes(locale) ? locale : null;

app.whenReady().then(async () => {
  if (!config.get('options.language')) {
    const locale = getDefaultLocale(app.getLocale());
    if (locale) {
      config.set('options.language', locale);
    }
  }

  await loadI18n().then(async () => {
    await setLanguage(config.get('options.language') ?? 'en');
    console.log(LoggerPrefix, t('main.console.i18n.loaded'));
  });

  if (config.get('options.autoResetAppCache')) {
    // Clear cache after 20s
    const clearCacheTimeout = setTimeout(() => {
      if (is.dev()) {
        console.log(
          LoggerPrefix,
          t('main.console.when-ready.clearing-cache-after-20s'),
        );
      }

      session.defaultSession.clearCache();
      clearTimeout(clearCacheTimeout);
    }, 20_000);
  }

  // Register appID on windows
  if (is.windows()) {
    const appID = 'com.github.th-ch.youtube-music';
    app.setAppUserModelId(appID);
    const appLocation = process.execPath;
    const appData = app.getPath('appData');
    // Check shortcut validity if not in dev mode / running portable app
    if (
      !is.dev() &&
      !appLocation.startsWith(path.join(appData, '..', 'Local', 'Temp'))
    ) {
      const shortcutPath = path.join(
        appData,
        'Microsoft',
        'Windows',
        'Start Menu',
        'Programs',
        'YouTube Music.lnk',
      );
      try {
        // Check if shortcut is registered and valid
        const shortcutDetails = shell.readShortcutLink(shortcutPath); // Throw error if doesn't exist yet
        if (
          shortcutDetails.target !== appLocation ||
          shortcutDetails.appUserModelId !== appID
        ) {
          throw 'needUpdate';
        }
      } catch (error) {
        // If not valid -> Register shortcut
        shell.writeShortcutLink(
          shortcutPath,
          error === 'needUpdate' ? 'update' : 'create',
          {
            target: appLocation,
            cwd: path.dirname(appLocation),
            description: 'YouTube Music Desktop App - including custom plugins',
            appUserModelId: appID,
          },
        );
      }
    }
  }

  mainWindow = await createMainWindow();
  await setApplicationMenu(mainWindow);
  await refreshMenu(mainWindow);
  setUpTray(app, mainWindow);

  setupProtocolHandler(mainWindow);

  app.on('second-instance', (_, commandLine) => {
    const uri = `${APP_PROTOCOL}://`;
    const protocolArgv = commandLine.find((arg) => arg.startsWith(uri));
    if (protocolArgv) {
      const lastIndex = protocolArgv.endsWith('/') ? -1 : undefined;
      const command = protocolArgv.slice(uri.length, lastIndex);
      if (is.dev()) {
        console.debug(
          LoggerPrefix,
          t('main.console.second-instance.receive-command', { command }),
        );
      }

      handleProtocol(command);
      return;
    }

    if (!mainWindow) {
      return;
    }

    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }

    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }

    mainWindow.focus();
  });

  // Autostart at login
  app.setLoginItemSettings({
    openAtLogin: config.get('options.startAtLogin'),
  });

  if (!is.dev() && config.get('options.autoUpdates')) {
    const updateTimeout = setTimeout(() => {
      autoUpdater.checkForUpdatesAndNotify();
      clearTimeout(updateTimeout);
    }, 2000);
    autoUpdater.on('update-available', () => {
      const downloadLink =
        'https://github.com/th-ch/youtube-music/releases/latest';
      const dialogOptions: Electron.MessageBoxOptions = {
        type: 'info',
        buttons: [
          t('main.dialog.update-available.buttons.download'),
          t('main.dialog.update-available.buttons.ok'),
          t('main.dialog.update-available.buttons.disable'),
        ],
        title: t('main.dialog.update-available.title'),
        message: t('main.dialog.update-available.message'),
        detail: t('main.dialog.update-available.detail', { downloadLink }),
      };

      let dialogPromise: Promise<Electron.MessageBoxReturnValue>;
      if (mainWindow) {
        dialogPromise = dialog.showMessageBox(mainWindow, dialogOptions);
      } else {
        dialogPromise = dialog.showMessageBox(dialogOptions);
      }

      dialogPromise.then((dialogOutput) => {
        switch (dialogOutput.response) {
          // Download
          case 1: {
            shell.openExternal(downloadLink);
            break;
          }

          // Disable updates
          case 2: {
            config.set('options.autoUpdates', false);
            break;
          }

          default: {
            break;
          }
        }
      });
    });
  }

  if (config.get('options.hideMenu') && !config.get('options.hideMenuWarned')) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: t('main.dialog.hide-menu-enabled.title'),
      message: t('main.dialog.hide-menu-enabled.message'),
    });
    config.set('options.hideMenuWarned', true);
  }

  // Optimized for Mac OS X
  if (is.macOS() && !config.get('options.appVisible')) {
    app.dock.hide();
  }

  let forceQuit = false;
  app.on('before-quit', () => {
    forceQuit = true;
  });

  if (is.macOS() || config.get('options.tray')) {
    mainWindow.on('close', (event) => {
      // Hide the window instead of quitting (quit is available in tray options)
      if (!forceQuit) {
        event.preventDefault();
        mainWindow!.hide();
      }
    });
  }
});

function showUnresponsiveDialog(
  win: BrowserWindow,
  details: Electron.RenderProcessGoneDetails,
) {
  if (details) {
    console.error(
      LoggerPrefix,
      t('main.console.unresponsive.details', {
        error: JSON.stringify(details, null, '\t'),
      }),
    );
  }

  dialog
    .showMessageBox(win, {
      type: 'error',
      title: t('main.dialog.unresponsive.title'),
      message: t('main.dialog.unresponsive.message'),
      detail: t('main.dialog.unresponsive.detail'),
      buttons: [
        t('main.dialog.unresponsive.buttons.wait'),
        t('main.dialog.unresponsive.buttons.relaunch'),
        t('main.dialog.unresponsive.buttons.quit'),
      ],
      cancelId: 0,
    })
    .then((result) => {
      switch (result.response) {
        case 1: {
          restart();
          break;
        }

        case 2: {
          app.quit();
          break;
        }
      }
    });
}

function removeContentSecurityPolicy(
  betterSession: BetterSession = session.defaultSession as BetterSession,
) {
  // Allows defining multiple "onHeadersReceived" listeners
  // by enhancing the session.
  // Some plugins (e.g. adblocker) also define a "onHeadersReceived" listener
  enhanceWebRequest(betterSession);

  // Custom listener to tweak the content security policy
  betterSession.webRequest.onHeadersReceived((details, callback) => {
    details.responseHeaders ??= {};

    // Remove the content security policy
    delete details.responseHeaders['content-security-policy-report-only'];
    delete details.responseHeaders['content-security-policy'];

    callback({ cancel: false, responseHeaders: details.responseHeaders });
  });

  // When multiple listeners are defined, apply them all
  betterSession.webRequest.setResolver(
    'onHeadersReceived',
    async (listeners) => {
      return listeners.reduce(
        async (accumulator, listener) => {
          const acc = await accumulator;
          if (acc.cancel) {
            return acc;
          }

          const result = await listener.apply();
          return { ...accumulator, ...result };
        },
        Promise.resolve({ cancel: false }),
      );
    },
  );
}
