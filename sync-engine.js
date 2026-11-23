'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { COPYFILE_EXCL } = require('node:fs').constants;
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const backup = require('./backup');
const progress = require('./progress');

const stagePrefix = '.robocopy-lite-stage-';
const dirMarker = 'dir\0';

function offline(message) {
  return Object.assign(new Error(message), { offline: true });
}

async function rootInfo(folder) {
  try {
    const info = await fs.stat(folder, { bigint: true });
    if (!info.isDirectory()) throw new Error('不是文件夹');
    const key = await backup.canonicalFolder(folder);
    return { key, identity: key + '|' + info.dev + '|' + info.ino };
  } catch {
    throw offline('文件夹不可用：' + folder);
  }
}

async function verifyRoots(config, previous) {
  const roots = await Promise.all([rootInfo(config.source), rootInfo(config.target)]);
  if (backup.overlaps(roots[0].key, roots[1].key)) throw offline('源和目标指向同一位置或互相包含。');
  if (previous && roots.some((root, index) => root.identity !== previous[index])) {
    throw offline('文件夹或盘符指向的位置已变化。请核对路径后重新绑定任务。');
  }
  return roots;
}

async function runCopy(args, signal, onChild) {
  signal.throwIfAborted();
  const child = backup.launch(args);
  const stop = () => child.kill();
  signal.addEventListener('abort', stop, { once: true });
  onChild(child);
  try {
    const [code] = await once(child, 'close');
    signal.throwIfAborted();
    if (code === null || code < 0 || code >= 8) throw new Error('Robocopy 复制失败，退出码：' + code);
    return code;
  } finally {
    onChild(null);
    signal.removeEventListener('abort', stop);
  }
}

function fileStamp(info) {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
}

async function fingerprint(file, cached, signal) {
  signal.throwIfAborted();
  let info;
  try { info = await fs.lstat(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('此处需要普通文件：' + file);
  const stamp = fileStamp(info);
  if (cached?.stamp === stamp) return cached;
  if (Date.now() - Number(info.mtimeMs) < 1800) throw Object.assign(new Error('文件仍在更新'), { changed: true });
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(file, { signal })) digest.update(bytes);
  if (stamp !== fileStamp(await fs.lstat(file, { bigint: true }))) {
    throw Object.assign(new Error('读取期间文件发生变动'), { changed: true });
  }
  return { stamp, hash: digest.digest('hex') };
}

function matcher(patterns) {
  const rules = patterns.map(pattern => new RegExp('^' + (pattern === '*.*' ? '*' : pattern)
    .replace(/[.+^$(){}|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.') + '$', 'i'));
  return (name, relative) => rules.some(rule => rule.test(name) || rule.test(relative));
}

async function inventory(root, config, cache, signal) {
  const files = new Map();
  const directories = new Map();
  const unstable = new Set();
  const skipFile = matcher(config.excludeFiles);
  const skipDir = matcher(config.excludeDirs);
  async function visit(folder, relative) {
    signal.throwIfAborted();
    for await (const entry of await fs.opendir(folder)) {
      signal.throwIfAborted();
      if (entry.isSymbolicLink() || entry.name.startsWith(stagePrefix)) continue;
      const name = path.join(relative, entry.name);
      const location = path.join(folder, entry.name);
      if (entry.isDirectory() && !skipDir(entry.name, name)) {
        directories.set(name.toLowerCase(), name);
        await visit(location, name);
      }
      if (!entry.isFile() || skipFile(entry.name, name)) continue;
      const key = name.toLowerCase();
      try {
        const state = await fingerprint(location, cache.get(key), signal);
        if (state) files.set(key, { ...state, name });
        else unstable.add(key);
      } catch (error) {
        if (!error.changed && error.code !== 'ENOENT' && error.code !== 'EBUSY') throw error;
        unstable.add(key);
      }
    }
  }
  await visit(root, '');
  return { files, directories, unstable };
}

async function assureFolder(root, folder, rootKey, create) {
  // Check each existing parent before walking deeper or creating it.
  const parts = path.relative(root, folder).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    let info;
    try { info = await fs.lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      try { await fs.mkdir(current); }
      catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
      info = await fs.lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('同步路径内含非普通目录：' + current);
  }
  const key = await backup.canonicalFolder(folder);
  if (key !== rootKey && !key.startsWith(rootKey + '\\')) throw new Error('路径超出任务文件夹：' + folder);
}

async function publishNew(staged, destination) {
  try {
    await fs.link(staged, destination);
  } catch (error) {
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'UNKNOWN'].includes(error.code)) throw error;
    await fs.copyFile(staged, destination, COPYFILE_EXCL);
  }
}

async function transfer(context, from, source, targetName, before) {
  const { config, roots, signal, onChild, logger, logPath, report } = context;
  const sourceRoot = from === 0 ? config.source : config.target;
  const targetRoot = from === 0 ? config.target : config.source;
  const original = path.join(sourceRoot, source.name);
  const destination = path.join(targetRoot, targetName);
  report?.({ stage: 'copying', file: original, filePercent: null });
  const parent = path.dirname(destination);
  await verifyRoots(config, roots.map(root => root.identity));
  await assureFolder(sourceRoot, path.dirname(original), roots[from].key, false);
  await assureFolder(targetRoot, parent, roots[1 - from].key, true);
  const requireVersion = async (file, expected, cached) => {
    const current = await fingerprint(file, cached, signal);
    if ((current?.hash ?? null) !== expected) throw Object.assign(new Error('复制期间文件发生变动：' + file), { changed: true });
  };
  await requireVersion(original, source.hash, source);
  await requireVersion(destination, before?.hash ?? null, before);
  const staging = await fs.mkdtemp(path.join(parent, stagePrefix));
  const staged = path.join(staging, path.basename(original));
  try {
    await logger('复制 ' + source.name + ' → ' + destination);
    const args = [path.dirname(original), staging, path.basename(original), '/R:2', '/W:3', '/XJ', '/UNILOG+:' + logPath];
    if (config.resume) args.push('/Z');
    if (config.speed === 'low') args.push('/IPG:25');
    const offset = (await fs.stat(logPath)).size;
    const stopProgress = progress.monitorLog(logPath, offset, line => {
      const update = progress.logEntry(line);
      if (update?.percent != null) report?.({ filePercent: update.percent });
    });
    try { await runCopy(args, signal, onChild); }
    finally { await stopProgress(); }
    report?.({ stage: 'verifying' });
    const verified = await fingerprint(staged, null, signal);
    if (verified?.hash !== source.hash) throw Object.assign(new Error('复制期间源文件发生变动'), { changed: true });
    await verifyRoots(config, roots.map(root => root.identity));
    await assureFolder(targetRoot, parent, roots[1 - from].key, false);
    await requireVersion(original, source.hash, source);
    await requireVersion(destination, before?.hash ?? null, before);
    signal.throwIfAborted();
    if (before) await fs.rename(staged, destination);
    else {
      try { await publishNew(staged, destination); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        throw Object.assign(new Error('对端刚新增同名文件：' + destination), { changed: true });
      }
    }
  } finally {
    const current = await rootInfo(targetRoot).catch(() => null);
    if (current?.identity === roots[1 - from].identity) {
      await fs.unlink(staged).catch(() => {});
      await fs.rmdir(staging).catch(() => {});
    }
  }
}

async function copyBothVersions(context, left, right, key, inventories) {
  const ext = path.extname(right.name);
  const prefix = right.name.slice(0, right.name.length - ext.length);
  const alternate = prefix + '（右侧-' + right.hash.slice(0, 12) + '）' + ext;
  const alternateKey = alternate.toLowerCase();
  for (const view of inventories) {
    const prior = view.files.get(alternateKey);
    if (view.unstable.has(alternateKey) || (prior && prior.hash !== right.hash)) {
      throw new Error('冲突副本文件名已被占用：' + alternate);
    }
  }
  if (!inventories[0].files.has(alternateKey)) await transfer(context, 1, right, alternate, null);
  if (!inventories[1].files.has(alternateKey)) {
    await transfer(context, 0, { ...right, name: alternate, stamp: undefined }, alternate, null);
  }
  context.baseline.set(alternateKey, right.hash);
  await transfer(context, 0, left, right.name, right);
  context.baseline.set(key, left.hash);
}

async function syncBoth(context) {
  const { config, signal, baseline, decisions, cache, logger, report } = context;
  report?.({ stage: 'scanning' });
  const inventories = await Promise.all([
    inventory(config.source, config, cache[0], signal),
    inventory(config.target, config, cache[1], signal),
  ]);
  for (const [index, view] of inventories.entries()) cache[index] = view.files;
  const [first, second] = inventories;
  const keys = new Set([...first.files.keys(), ...second.files.keys(), ...[...baseline.keys()].filter(key => !key.startsWith(dirMarker)),
    ...first.unstable, ...second.unstable]);
  const directories = new Set([...first.directories.keys(), ...second.directories.keys()]);
  const total = keys.size + directories.size;
  let handled = 0;
  const step = () => {
    report?.({ stage: 'comparing', file: null, filePercent: null,
      overall: total ? 100 * handled / total : null, handled, total });
    handled++;
  };
  const conflicts = [];
  let deferred = false;
  let copies = 0;
  for (const key of keys) {
    signal.throwIfAborted();
    step();
    if (first.unstable.has(key) || second.unstable.has(key)) {
      deferred = true;
      continue;
    }
    const left = first.files.get(key);
    const right = second.files.get(key);
    const prior = baseline.get(key);
    if (left?.hash === right?.hash) {
      if (left) baseline.set(key, left.hash);
      else baseline.delete(key);
      continue;
    }

    try {
      if (!left || !right) {
        const existing = left || right;
        if (existing.hash !== prior) {
          await transfer(context, left ? 0 : 1, existing, existing.name, null);
          baseline.set(key, existing.hash);
          copies++;
        }
        continue;
      }
      const choice = decisions.get(key);
      if (choice?.left === left.hash && choice?.right === right.hash) {
        if (choice.keep === 'both') {
          await copyBothVersions(context, left, right, key, inventories);
        } else {
          const preferLeft = choice.keep === 'left';
          const selected = preferLeft ? left : right;
          const other = preferLeft ? right : left;
          await transfer(context, preferLeft ? 0 : 1, selected, other.name, other);
          baseline.set(key, selected.hash);
        }
        decisions.delete(key);
        copies++;
      } else if (prior === right.hash || prior === left.hash) {
        const leftChanged = prior === right.hash;
        const selected = leftChanged ? left : right;
        const other = leftChanged ? right : left;
        await transfer(context, leftChanged ? 0 : 1, selected, other.name, other);
        baseline.set(key, selected.hash);
        copies++;
      } else {
        decisions.delete(key);
        conflicts.push({ key, name: left.name, left: left.hash, right: right.hash });
        await logger('待处理同名文件：' + left.name);
      }
    } catch (error) {
      if (!error.changed) throw error;
      deferred = true;
    }
  }
  for (const key of directories) {
    signal.throwIfAborted();
    step();
    const left = first.directories.get(key);
    const right = second.directories.get(key);
    const directoryKey = dirMarker + key;
    if (left && right) {
      baseline.set(directoryKey, true);
      continue;
    }
    if (baseline.has(directoryKey)) continue;
    if (first.files.has(key) || second.files.has(key) || first.unstable.has(key) || second.unstable.has(key)) continue;
    const { roots } = context;
    await verifyRoots(config, roots.map(root => root.identity));
    const target = left ? config.target : config.source;
    const targetKey = roots[left ? 1 : 0].key;
    await assureFolder(target, path.join(target, left || right), targetKey, true);
    baseline.set(directoryKey, true);
    copies++;
  }
  for (const key of baseline.keys()) {
    if (!key.startsWith(dirMarker)) continue;
    const relative = key.slice(dirMarker.length);
    if (!first.directories.has(relative) && !second.directories.has(relative)) baseline.delete(key);
  }
  return { conflicts, deferred, copies };
}

async function syncOnce(context) {
  const { config, logPath, signal, onChild, preview, report } = context;
  if (config.mode === 'two') return syncBoth(context);
  if (preview) {
    report?.({ stage: 'preview' });
    const code = await runCopy(backup.copyArguments(config, true, logPath), signal, onChild);
    return { conflicts: [], deferred: false, copies: code & 1 ? null : 0, code };
  }
  report?.({ stage: 'scanning' });
  const planFile = logPath + '.plan';
  let plan;
  try {
    await runCopy(backup.copyArguments(config, true, planFile), signal, onChild);
    plan = await progress.scanPlan(planFile, config.source, signal);
  } catch {
    signal.throwIfAborted();
  } finally {
    await fs.unlink(planFile).catch(() => {});
  }
  report?.({ stage: 'copying', overall: plan?.count ? 0 : null, totalBytes: plan?.bytes, transferred: 0 });
  const receive = progress.singleReporter(plan, config.source, state => report?.(state));
  const stopProgress = progress.monitorLog(logPath, 0, receive);
  let code;
  try { code = await runCopy(backup.copyArguments(config, false, logPath), signal, onChild); }
  finally { await stopProgress(); }
  return { conflicts: [], deferred: false, copies: code & 1 ? null : 0, code };
}

module.exports = { rootInfo, verifyRoots, runCopy, syncOnce };
