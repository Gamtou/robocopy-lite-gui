'use strict';

const { app, BrowserWindow, dialog, ipcMain, Menu, Tray, Notification, shell } = require('electron');
const path = require('node:path');
const backup = require('./backup');
const { externalProgress } = require('./progress');
const { readFailure } = require('./diagnostics');
const Tasks = require('./tasks');

app.setName('Robocopy Lite');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  launch();
}

function launch() {
  let window;
  let tray;
  let tasks;
  let closing = false;
  let mayExit = false;
  let external = new Map();
  const handled = new Map();
  const externalSamples = new Set();
  let scanState = 'checking';
  let scanning;
  let scanTimer;
  let logTimer;
  let operations = Promise.resolve();
  const icon = path.join(__dirname, '../assets/sync.ico');

  function refreshExternal() {
    if (scanning) return scanning;
    scanning = backup.scanProcesses().then(rows => {
      for (const [id, at] of handled) {
        if (Date.now() - at > 15000) handled.delete(id);
      }
      const next = new Map(rows.filter(row => !handled.has(row.id)).map(row => [
        row.id, { ...row, progress: external.get(row.id)?.progress },
      ]));
      const own = ownedPids();
      for (const [id, job] of external) {
        if (handled.has(id)) continue;
        if (!next.has(id) && !job.ended && !own.has(job.pid)) {
          next.set(id, { ...job, ended: Date.now(), state: 'unknown' });
        }
        if (job.ended && Date.now() - job.ended < 5 * 60 * 1000) next.set(id, job);
      }
      external = next;
      scanState = 'ready';
    }).catch(() => {
      if (scanState !== 'unavailable' && !closing) {
        tasks.recordProblem('外部 Robocopy 查询失败', 'Windows 进程查询暂不可用。');
        void tasks.save().catch(() => {});
      }
      scanState = 'unavailable';
    }).finally(() => { scanning = undefined; });
    return scanning;
  }

  function readExternalLog(job) {
    if (!job.logPath) return Promise.resolve('');
    return backup.tailLog(job.logPath, { unicode: job.unicodeLog, since: job.started, locale: app.getLocale() });
  }

  function sampleExternalProgress() {
    const own = ownedPids();
    for (const job of external.values()) {
      if (!job.logPath || job.ended || own.has(job.pid) || externalSamples.has(job.id)) continue;
      externalSamples.add(job.id);
      void readExternalLog(job).then(text => {
        const row = external.get(job.id);
        if (row && !row.ended) row.progress = text ? externalProgress(text) : null;
      }).catch(() => {
        const row = external.get(job.id);
        if (row && !row.ended) row.progress = null;
      }).finally(() => externalSamples.delete(job.id));
    }
  }

  function ownedPids() {
    return tasks.ownedPids();
  }

  function showWindow() {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  function autoStart(enabled) {
    const loginPath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const args = app.isPackaged ? ['--background'] : [app.getAppPath(), '--background'];
    app.setLoginItemSettings({ openAtLogin: enabled, path: loginPath, args });
  }

  function notify(title, body) {
    if (!tasks.settings.notifications || !Notification.isSupported()) return;
    new Notification({ title, body, icon }).show();
  }

  function bind(channel, callback) {
    ipcMain.handle(channel, (_event, ...args) => {
      if (closing) throw new Error('应用正在退出。');
      const operation = operations.then(async () => {
        if (closing) throw new Error('应用正在退出。');
        try { return await callback(...args); }
        catch (error) {
          const labels = {
            configure: '保存任务失败', start: '开始任务失败', pause: '暂停任务失败', remove: '删除任务失败',
            preview: '预览失败', 'cancel-external': '取消外部任务失败', 'adopt-external': '接管外部任务失败',
            'resolve-conflict': '处理冲突失败', settings: '保存设置失败',
          };
          const task = tasks.tasks.get(args[0]) || external.get(args[0]);
          tasks.recordProblem(labels[channel], error.message, task);
          void tasks.save().catch(() => {});
          throw error;
        }
      });
      operations = operation.catch(() => {});
      return operation;
    });
  }

  function externalJob(id) {
    const job = external.get(id);
    if (!job || ownedPids().has(job.pid)) throw new Error('该外部任务已从列表移除，请刷新后重试。');
    return job;
  }

  async function finishExternal(job) {
    if (!job.ended) await backup.stopExternal(job);
    external.delete(job.id);
    handled.set(job.id, Date.now());
  }

  async function adoptExternal(id, form) {
    const job = externalJob(id);
    const draft = form ?? {
      name: '外部 Robocopy ' + job.pid, source: job.source, target: job.target, mode: 'one',
    };
    const { config } = await backup.validate(draft);
    const existing = [...tasks.tasks.values()].find(task =>
      backup.folderKey(task.config.source) === backup.folderKey(config.source) &&
      backup.folderKey(task.config.target) === backup.folderKey(config.target));
    if (existing && (existing.enabled || existing.rt.running || form || existing.config.mode !== 'one')) {
      throw new Error('同样的目录已经有任务「' + existing.config.name + '」。可以取消外部进程，再管理现有任务。');
    }
    const taskId = existing?.id ?? await tasks.configure(null, draft, 'external');
    try {
      await finishExternal(job);
    } catch (error) {
      if (!existing) {
        try { await tasks.remove(taskId); }
        catch { throw new Error(error.message + ' 已保存的接管配置仍处于暂停状态。'); }
      }
      throw error;
    }
    return taskId;
  }

  function register() {
    ipcMain.handle('snapshot', () => {
      const own = ownedPids();
      return {
        tasks: [...tasks.tasks.values()].map(task => tasks.view(task)),
        external: [...external.values()].filter(job => !own.has(job.pid)).slice(0, 30),
        version: app.getVersion(), scanState, settings: tasks.settings, storageError: tasks.storageError,
      };
    });
    ipcMain.handle('choose-folder', async () => {
      const result = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] });
      return result.canceled ? null : result.filePaths[0];
    });
    ipcMain.handle('log', (_event, id, runId) => {
      const task = tasks.get(id);
      if (!/^[0-9a-f-]{36}$/i.test(runId) ||
          (task.rt.runId !== runId && !task.history.some(run => run.id === runId))) return '';
      return backup.tailLog(path.join(tasks.logs, runId + '.log'));
    });
    ipcMain.handle('logs-snapshot', () => {
      const own = ownedPids();
      const observed = [...external.values()].filter(job => job.logPath && !own.has(job.pid)).map(job => ({
        id: job.id, taskId: job.id, taskName: '外部 Robocopy ' + job.pid, source: job.source, target: job.target,
        state: job.state, started: job.started, ended: job.ended, lastFile: job.progress?.file, kind: 'external',
      }));
      return [...tasks.logEntries(), ...observed];
    });
    ipcMain.handle('diagnostic-log', (_event, id) => {
      const job = external.get(id);
      if (job && !ownedPids().has(job.pid)) return readExternalLog(job);
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id) || !tasks.hasLog(id)) return '';
      return backup.tailLog(path.join(tasks.logs, id + '.log'));
    });
    ipcMain.handle('diagnostic-report', (_event, id) => {
      if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id) || !tasks.hasLog(id)) return null;
      const record = tasks.journal.find(item => item.id === id) ||
        [...tasks.tasks.values()].flatMap(task => task.history).find(item => item.id === id);
      if (record?.state !== 'error') return null;
      const oldCode = record.error?.match(/退出码[：:\s]+(\d+)/)?.[1];
      return record.diagnosis || readFailure(path.join(tasks.logs, id + '.log'), record.code ?? (oldCode ? Number(oldCode) : undefined));
    });
    ipcMain.handle('open-logs-folder', () => shell.openPath(tasks.logs));
    bind('configure', (id, form) => tasks.configure(id, form));
    bind('start', async id => {
      await refreshExternal();
      await tasks.start(id);
    });
    bind('pause', id => tasks.pause(tasks.get(id)));
    bind('cancel-external', id => finishExternal(externalJob(id)));
    bind('adopt-external', (id, form) => adoptExternal(id, form));
    bind('remove', id => tasks.remove(id));
    bind('preview', id => tasks.preview(id));
    bind('resolve-conflict', (id, key, keep) => tasks.decide(id, key, keep));
    bind('settings', async input => {
      const previous = tasks.settings;
      const updated = { tray: input.tray === true, autoStart: input.autoStart === true, notifications: input.notifications === true };
      if (previous.autoStart !== updated.autoStart) autoStart(updated.autoStart);
      tasks.settings = updated;
      try { await tasks.save(); }
      catch (error) {
        tasks.settings = previous;
        if (previous.autoStart !== updated.autoStart) autoStart(previous.autoStart);
        throw error;
      }
    });
  }

  app.on('second-instance', showWindow);
  app.on('before-quit', event => {
    if (mayExit) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    clearInterval(scanTimer);
    clearInterval(logTimer);
    void operations.then(() => tasks?.close()).finally(() => {
      mayExit = true;
      tray?.destroy();
      if (window && !window.isDestroyed()) window.destroy();
      app.quit();
    });
  });
  app.whenReady().then(async () => {
    tasks = new Tasks(app.getPath('userData'), () => [...external.values()].filter(item => !item.ended));
    tasks.notify = notify;
    await tasks.load();
    register();
    window = new BrowserWindow({
      width: 1070, height: 750, minWidth: 715, minHeight: 545, icon,
      title: 'Robocopy Lite', backgroundColor: '#f2f5fa', autoHideMenuBar: true, show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.once('ready-to-show', () => {
      if (!process.argv.includes('--background') || !tasks.settings.tray) showWindow();
    });
    window.on('close', event => {
      if (mayExit) return;
      event.preventDefault();
      if (tasks.settings.tray) window.hide();
      else app.quit();
    });
    tray = new Tray(icon);
    tray.setToolTip('Robocopy Lite');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开面板', click: showWindow },
      { label: '退出', click: () => app.quit() },
    ]));
    tray.on('double-click', showWindow);
    operations = refreshExternal().then(async () => {
      for (const task of tasks.tasks.values()) {
        if (task.enabled && !closing) await tasks.start(task.id, true);
      }
    }).catch(error => { tasks.storageError = error.message; });
    scanTimer = setInterval(refreshExternal, 4500);
    scanTimer.unref();
    logTimer = setInterval(sampleExternalProgress, 850);
    logTimer.unref();
    await window.loadFile(path.join(__dirname, 'index.html'));
  }).catch(error => {
    dialog.showErrorBox('无法启动 Robocopy Lite', error.message);
    mayExit = true;
    app.quit();
  });
}
