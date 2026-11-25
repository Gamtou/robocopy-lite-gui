'use strict';

const fs = require('node:fs/promises');
const { watch } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const backup = require('./backup');
const engine = require('./sync-engine');
const { readFailure } = require('./diagnostics');

const settleMs = 2200;
const fullScanMs = 60000;
const fallbackScanMs = 20000;

function runtime() {
  return { watchers: [], cache: [new Map(), new Map()], decisions: new Map() };
}

function printable(config) {
  return { ...config, name: config.name || '同步任务', mode: config.mode === 'two' ? 'two' : 'one' };
}

function checkOverlap(a, b) {
  return ((a.config.mode === 'two' || b.config.mode === 'two') && backup.overlaps(a.keys[0], b.keys[0])) ||
    backup.overlaps(a.keys[0], b.keys[1]) || backup.overlaps(a.keys[1], b.keys[0]) ||
    backup.overlaps(a.keys[1], b.keys[1]);
}

class Tasks {
  constructor(folder, external) {
    this.folder = folder;
    this.file = path.join(folder, 'backups.json');
    this.logs = path.join(folder, 'logs');
    this.baselines = path.join(folder, 'baselines');
    this.tasks = new Map();
    this.journal = [];
    this.recentPids = new Map();
    this.external = external;
    this.settings = { autoStart: false, tray: true, notifications: false };
    this.writes = Promise.resolve();
    this.closed = false;
  }

  async load() {
    await Promise.all([fs.mkdir(this.logs, { recursive: true }), fs.mkdir(this.baselines, { recursive: true })]);
    let data;
    try { data = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('无法读取任务记录，原文件已保留：' + error.message);
      return;
    }
    if (data.version === 2) {
      this.settings = { ...this.settings, ...data.settings };
      for (const record of data.tasks) {
        if (!/^[0-9a-f-]{36}$/i.test(record.id)) continue;
        const task = { ...record, config: printable(record.config), rt: runtime() };
        this.tasks.set(task.id, task);
      }
      this.journal = Array.isArray(data.journal) ? data.journal : this.pastRuns();
      return;
    }
    const imported = new Map();
    const importConfig = config => {
      const key = backup.folderKey(config.source) + '|' + backup.folderKey(config.target);
      if (!imported.has(key)) {
        const task = this.make(config);
        imported.set(key, task);
      }
      return imported.get(key);
    };
    for (const preset of data.presets ?? []) importConfig(preset);
    for (const run of data.recent ?? []) {
      if (!run.config || run.preview) continue;
      const task = importConfig(run.config);
      if (task.history.length < 20) {
        const { id, state, code, error, started, ended } = run;
        task.history.push({ id, state, code, error, started, ended });
      }
    }
    this.journal = this.pastRuns();
    await this.atomic(this.file + '.v1', data);
    await this.save();
  }

  atomic(file, value) {
    const contents = JSON.stringify(value, null, 2);
    const write = this.writes.then(async () => {
      await fs.writeFile(file + '.tmp', contents, 'utf8');
      await fs.rename(file + '.tmp', file);
      this.storageError = '';
    });
    this.writes = write.catch(error => { this.storageError = '无法保存任务数据：' + error.message; });
    return write;
  }

  save() {
    const tasks = [...this.tasks.values()].map(({ rt, ...record }) => record);
    return this.atomic(this.file, { version: 2, settings: this.settings, tasks, journal: this.journal });
  }

  runEntry(task, run) {
    const { config, id: taskId } = task;
    const state = run.conflictCount ? 'conflict' : run.state;
    return { ...run, state, taskId, taskName: config.name, source: config.source, target: config.target, kind: 'run' };
  }

  pastRuns() {
    return [...this.tasks.values()].flatMap(task => task.history.map(run => this.runEntry(task, run)))
      .sort((a, b) => b.ended - a.ended).slice(0, 300);
  }

  remember(entry) {
    this.journal = [entry, ...this.journal].slice(0, 300);
  }

  recordProblem(title, description, task, state = 'error') {
    const config = task?.config ?? task;
    this.remember({
      id: randomUUID(), taskId: task?.id, taskName: config?.name || (task ? '外部 Robocopy' : '应用'),
      source: config?.source, target: config?.target, title, error: description,
      state, kind: 'event', ended: Date.now(),
    });
  }

  logEntries() {
    const active = [...this.tasks.values()].filter(task => task.rt.runId).map(task => this.runEntry(task, {
      id: task.rt.runId, started: task.rt.started, preview: task.rt.preview,
      state: task.rt.preview ? 'preview' : 'syncing', lastFile: task.rt.progress?.file,
    }));
    return [...active, ...this.journal];
  }

  hasLog(id) {
    return this.journal.some(entry => entry.id === id && entry.kind === 'run') ||
      [...this.tasks.values()].some(task => task.rt.runId === id || task.history.some(entry => entry.id === id));
  }

  baselinePath(task) {
    return path.join(this.baselines, task.id + '.json');
  }

  async baseline(task) {
    if (!task.rt.baseline) {
      try { task.rt.baseline = new Map(JSON.parse(await fs.readFile(this.baselinePath(task), 'utf8'))); }
      catch (error) {
        if (error.code !== 'ENOENT') throw new Error('无法读取双向同步基准：' + error.message);
        task.rt.baseline = new Map();
      }
    }
    return task.rt.baseline;
  }

  make(config) {
    const task = {
      id: randomUUID(), config: printable(config), enabled: false, hold: '',
      history: [], conflicts: [], rt: runtime(),
    };
    this.tasks.set(task.id, task);
    return task;
  }

  get(id) {
    const task = this.tasks.get(id);
    if (!task) throw new Error('任务已不存在。');
    return task;
  }

  view(task) {
    const { rt, ...record } = task;
    const state = rt.preview ? 'preview' : !task.enabled ? (task.hold ? 'offline' : 'paused') :
      rt.running ? 'syncing' : task.conflicts.length ? 'conflict' : rt.error ? 'error' : 'watching';
    return {
      ...record, state, error: rt.error || task.hold, started: rt.started,
      currentRun: rt.runId, progress: rt.progress, conflicts: task.conflicts.map(({ key, name }) => ({ key, name })),
    };
  }

  async configure(id, form, origin) {
    const { config } = await backup.validate(form);
    config.mode = form.mode === 'two' ? 'two' : 'one';
    if (!config.name) throw new Error('请输入任务名称。');
    if (id === null) {
      const task = this.make(config);
      if (origin) task.origin = origin;
      try { await this.save(); } catch (error) { this.tasks.delete(task.id); throw error; }
      return task.id;
    }
    const task = this.get(id);
    if (task.enabled || task.rt.running) throw new Error('请先暂停任务，再修改配置。');
    const rebound = task.hold && task.identity && (await engine.verifyRoots(config).catch(() => null))
      ?.some((root, index) => root.identity !== task.identity[index]);
    const changed = rebound || task.config.mode !== config.mode || task.config.source !== config.source || task.config.target !== config.target;
    if (changed) {
      if (task.config.mode === 'two' || config.mode === 'two') await this.atomic(this.baselinePath(task), []);
      task.identity = undefined;
      task.lastSync = undefined;
      task.lastScanReported = false;
      task.conflicts = [];
      task.rt.baseline = new Map();
      task.rt.decisions.clear();
      task.rt.cache = [new Map(), new Map()];
    }
    task.config = config;
    task.rt.error = '';
    task.hold = '';
    await this.save();
    return id;
  }

  async ensureNoConflict(task, keys) {
    const contender = { config: task.config, keys };
    for (const other of this.tasks.values()) {
      if (other === task || (!other.enabled && !other.rt.running) || !other.rt.keys) continue;
      if (checkOverlap(contender, { config: other.config, keys: other.rt.keys })) {
        throw new Error('与任务「' + other.config.name + '」存在路径冲突。');
      }
    }
    const ourPids = this.ownedPids();
    for (const item of this.external()) {
      if (ourPids.has(item.pid) || item.preview || !item.source || !item.target) continue;
      const foreign = await Promise.all([
        backup.canonicalFolder(item.source),
        backup.canonicalFolder(item.target, true),
      ]).catch(() => null);
      if (foreign && checkOverlap(contender, { config: { mode: 'one' }, keys: foreign })) {
        throw new Error('与外部 Robocopy 任务存在路径冲突：' + item.target);
      }
    }
  }

  ownedPids() {
    const pids = new Set();
    for (const [pid, at] of this.recentPids) {
      if (Date.now() - at < 15000) pids.add(pid);
      else this.recentPids.delete(pid);
    }
    for (const task of this.tasks.values()) {
      if (task.rt.child?.pid) pids.add(task.rt.child.pid);
    }
    return pids;
  }

  async start(id, restoring = false) {
    const task = this.get(id);
    if (this.closed) throw new Error('应用正在退出。');
    if (!restoring && task.enabled) return;
    if (task.rt.running) throw new Error('请等待当前操作结束。');
    let roots;
    try {
      const before = await backup.validate({
        ...task.config,
        excludeFiles: task.config.excludeFiles.join('\n'),
        excludeDirs: task.config.excludeDirs.join('\n'),
      });
      await this.ensureNoConflict(task, [before.source, before.target]);
      if (!restoring && !task.identity) {
        await fs.mkdir(task.config.target, { recursive: true });
      }
      roots = await engine.verifyRoots(task.config, task.identity);
    } catch (error) {
      if (restoring) {
        await this.pause(task, '文件夹不可用或配置冲突：' + error.message);
        return;
      }
      throw error;
    }
    task.identity = roots.map(root => root.identity);
    task.rt.keys = roots.map(root => root.key);
    task.enabled = true;
    task.hold = '';
    task.rt.error = '';
    await this.save();
    this.watch(task);
    this.schedule(task, 0);
  }

  watch(task) {
    for (const watcher of task.rt.watchers) watcher.close();
    const roots = task.config.mode === 'two' ? [task.config.source, task.config.target] : [task.config.source];
    task.rt.watchers = [];
    for (const root of roots) {
      try {
        const watcher = watch(root, { recursive: true }, (_event, filename) => {
          if (filename && String(filename).split(/[\\/]/).some(part => part.startsWith('.robocopy-lite-stage-'))) return;
          this.schedule(task, settleMs);
        });
        watcher.on('error', () => {
          watcher.close();
          task.rt.watchers = task.rt.watchers.filter(item => item !== watcher);
          void this.check(task);
        });
        task.rt.watchers.push(watcher);
      } catch { /* The periodic scan covers folders without change notifications. */ }
    }
    task.rt.probe = setInterval(() => { void this.check(task); }, 3000);
  }

  async check(task) {
    const rt = task.rt;
    if (!task.enabled || this.closed || rt.checking) return;
    rt.checking = true;
    const generation = rt.generation;
    try {
      await engine.verifyRoots(task.config, task.identity);
      const deadline = rt.watchers.length === (task.config.mode === 'two' ? 2 : 1) ? fullScanMs : fallbackScanMs;
      if (task.enabled && generation === rt.generation && !rt.running && !rt.timer &&
          Date.now() - (rt.lastScan || 0) >= deadline) this.schedule(task, 0);
    } catch (error) {
      if (task.enabled && generation === rt.generation) {
        void this.pause(task, error.message).catch(() => {});
      }
    } finally {
      rt.checking = false;
    }
  }

  schedule(task, wait) {
    if (!task.enabled || this.closed) return;
    const rt = task.rt;
    if (rt.running) {
      rt.pending = true;
      return;
    }
    clearTimeout(rt.timer);
    rt.firstEvent ??= Date.now();
    const withinBurstLimit = Math.max(0, 10000 - (Date.now() - rt.firstEvent));
    rt.timer = setTimeout(() => {
      rt.timer = undefined;
      rt.firstEvent = undefined;
      if (!task.enabled || this.closed || rt.running) return;
      this.begin(task, false);
    }, Math.min(wait, withinBurstLimit));
  }

  begin(task, preview) {
    const rt = task.rt;
    rt.abort = new AbortController();
    rt.runId = randomUUID();
    rt.started = Date.now();
    rt.preview = preview;
    rt.progress = { stage: preview ? 'preview' : 'scanning' };
    rt.running = this.run(task, preview).finally(() => {
      const pending = rt.pending;
      rt.pending = false;
      rt.lastScan = Date.now();
      rt.running = null;
      rt.runId = '';
      rt.preview = false;
      rt.progress = null;
      if (pending) this.schedule(task, settleMs);
    });
    return rt.running;
  }

  async run(task, preview) {
    const { rt, config } = task;
    const signal = rt.abort.signal;
    const run = { id: rt.runId, started: rt.started, preview };
    const logPath = path.join(this.logs, run.id + '.log');
    const logger = line => fs.appendFile(logPath, line + '\r\n', 'utf16le');
    let hold;
    try {
      if (!preview && config.mode === 'two') await fs.writeFile(logPath, '\uFEFF', 'utf16le');
      const roots = preview ? null : await engine.verifyRoots(config, task.identity);
      if (!preview) await this.ensureNoConflict(task, roots.map(root => root.key));
      const result = await engine.syncOnce({
        config, logPath, signal, roots, baseline: config.mode === 'two' ? await this.baseline(task) : null,
        cache: rt.cache, decisions: rt.decisions, onChild: child => {
          if (rt.child?.pid) this.recentPids.set(rt.child.pid, Date.now());
          rt.child = child;
        }, logger, preview, report: state => {
          rt.progress = { ...rt.progress, ...state };
          if (state.file) run.lastFile = state.file;
        },
      });
      Object.assign(run, { state: 'done', code: result.code, copies: result.copies });
      if (!preview) {
        const knownConflicts = new Set(task.conflicts.map(item => item.key + '|' + item.left + '|' + item.right));
        if (result.conflicts.some(item => !knownConflicts.has(item.key + '|' + item.left + '|' + item.right))) {
          run.conflictCount = result.conflicts.length;
        }
        task.conflicts = result.conflicts;
        if (result.deferred) rt.pending = true;
      }
      if (!preview) rt.error = '';
    } catch (error) {
      if (signal.aborted) run.state = 'stopped';
      else {
        const current = preview ? null : await engine.verifyRoots(config, task.identity).catch(cause => cause);
        hold = error.offline ? error.message : current?.offline ? current.message : '';
        const diagnosis = error.robocopy ? await readFailure(logPath, error.exitCode).catch(() => null) : null;
        const explanation = diagnosis?.summary || error.message;
        Object.assign(run, { state: 'error', error: explanation, code: error.exitCode, diagnosis });
        if (!preview && !hold && rt.error !== explanation) this.notify?.('同步失败 · ' + config.name, explanation);
        if (!preview) rt.error = explanation;
      }
    } finally {
      if (!preview && config.mode === 'two' && rt.baseline) {
        await this.atomic(this.baselinePath(task), [...rt.baseline]).catch(() => {});
      }
      if (hold) {
        task.enabled = false;
        task.hold = hold;
        this.notify?.('任务已暂停 · ' + config.name, hold);
        this.quiet(task);
      }
      // Keep the last meaningful result and avoid filling history with unchanged periodic scans.
      if (run.state !== 'done' || run.copies !== 0 || run.conflictCount || preview || !task.history.length || !task.lastScanReported) {
        const entry = { ...run, ended: Date.now() };
        task.history = [entry, ...task.history].slice(0, 20);
        this.remember(this.runEntry(task, entry));
        task.lastScanReported = true;
      } else {
        await fs.unlink(logPath).catch(() => {});
      }
      if (!preview && run.state === 'done' && (run.copies !== 0 || !task.lastSync)) task.lastSync = Date.now();
      await this.save().catch(() => {});
    }
  }

  quiet(task) {
    const rt = task.rt;
    rt.generation = (rt.generation || 0) + 1;
    clearTimeout(rt.timer);
    clearInterval(rt.probe);
    rt.timer = undefined;
    rt.firstEvent = undefined;
    rt.pending = false;
    for (const watcher of rt.watchers.splice(0)) watcher.close();
    rt.abort?.abort();
  }

  async pause(task, hold = '') {
    task.enabled = false;
    task.hold = hold;
    this.quiet(task);
    if (hold) {
      this.recordProblem('文件夹不可用，任务已暂停', hold, task, 'offline');
      this.notify?.('任务已暂停 · ' + task.config.name, hold);
    }
    const saving = this.save();
    await Promise.all([task.rt.running, saving]);
  }

  async remove(id) {
    const task = this.get(id);
    await this.pause(task);
    this.tasks.delete(id);
    try { await this.save(); }
    catch (error) { this.tasks.set(id, task); throw error; }
    // Paths here are under the app's private data folder.
    await fs.unlink(this.baselinePath(task)).catch(() => {});
  }

  async preview(id) {
    const task = this.get(id);
    if (task.config.mode !== 'one') throw new Error('预览适用于单向备份。');
    if (task.enabled || task.rt.running) throw new Error('暂停任务后才可预览。');
    this.begin(task, true);
  }

  async decide(id, key, keep) {
    const task = this.get(id);
    const item = task.conflicts.find(entry => entry.key === key);
    if (!item || !['left', 'right', 'both'].includes(keep)) throw new Error('此冲突已变化，请刷新后再处理。');
    task.rt.decisions.set(key, { ...item, keep });
    this.schedule(task, 0);
  }

  async close() {
    this.closed = true;
    for (const task of this.tasks.values()) this.quiet(task);
    await Promise.all([...this.tasks.values()].map(task => task.rt.running));
    await this.writes;
  }
}

module.exports = Tasks;
