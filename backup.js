'use strict';

const fs = require('node:fs/promises');
const path = require('node:path').win32;
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const robocopy = path.join(system32, 'robocopy.exe');
const powershell = path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const execute = promisify(execFile);

function absoluteFolder(value, label) {
  if (typeof value !== 'string') throw new Error(label + '无效。');
  const folder = value.trim().replaceAll('/', '\\');
  if (!/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+(?:\\|$))/i.test(folder) ||
      /^\\\\[?.]\\/.test(folder) || /["<>|?*\u0000-\u001f]/.test(folder.slice(2))) {
    throw new Error(label + '需要完整路径，例如 C:\\资料 或 \\\\服务器\\共享。');
  }
  return path.resolve(folder);
}

function folderKey(value) {
  return path.normalize(value).replace(/^(?:\\\\\?\\UNC\\)/i, '\\\\')
    .replace(/^\\\\\?\\/, '').replace(/\\+$/, '').toLowerCase();
}

function overlaps(left, right) {
  return left === right || left.startsWith(right + '\\') || right.startsWith(left + '\\');
}

async function canonicalFolder(folder, allowMissing = false) {
  try {
    const info = await fs.stat(folder);
    if (!info.isDirectory()) throw new Error('路径不是文件夹：' + folder);
    return folderKey(await fs.realpath(folder));
  } catch (error) {
    const parent = path.dirname(folder);
    if (allowMissing && error.code === 'ENOENT' && parent !== folder) {
      const base = await canonicalFolder(parent, true);
      return folderKey(base + '\\' + path.basename(folder));
    }
    if (error.code) throw new Error('无法访问文件夹：' + folder);
    throw error;
  }
}

function exclusions(value) {
  return String(value ?? '').split(/\r?\n/).map(item => item.trim()).filter(Boolean).map(item => {
    if (/^[/\\-]|["<>|\u0000-\u001f]/.test(item)) {
      throw new Error('排除规则请使用名称或通配符，每行一条，例如 *.tmp。');
    }
    return item;
  });
}

async function validate(form) {
  const config = {
    name: String(form.name ?? '').trim().slice(0, 100),
    source: absoluteFolder(form.source, '源文件夹'),
    target: absoluteFolder(form.target, '目标文件夹'),
    resume: form.resume !== false,
    excludeFiles: exclusions(form.excludeFiles),
    excludeDirs: exclusions(form.excludeDirs),
    speed: String(form.speed ?? 'normal'),
  };
  if (!['normal', 'low'].includes(config.speed)) throw new Error('复制速度选项无效。');
  const [source, target] = await Promise.all([
    canonicalFolder(config.source),
    canonicalFolder(config.target, true),
  ]);
  if (overlaps(source, target)) throw new Error('源和目标不能相同或互相包含。');
  return { config, source, target };
}

function copyArguments(config, preview, logPath) {
  const args = [config.source, config.target, '/E', '/XO', '/XJ', '/XX', '/R:2', '/W:3', '/BYTES', '/FP', '/NDL'];
  if (config.resume) args.push('/Z');
  if (config.speed === 'low') args.push('/IPG:25');
  if (config.excludeFiles.length) args.push('/XF', ...config.excludeFiles);
  if (config.excludeDirs.length) args.push('/XD', ...config.excludeDirs);
  if (preview) args.push('/L', '/NP');
  return [...args, '/UNILOG:' + logPath];
}

function launch(args) {
  return spawn(robocopy, args, { windowsHide: true, stdio: 'ignore' });
}

function externalPaths(commandLine) {
  const tokens = commandLine?.match(/(?:[^\s"]|"[^"]*")+/g);
  if (!tokens) return {};
  const [, source, target, ...options] = tokens.map(token => token.replace(/^"|"$/g, ''));
  const preview = options.some(token => /^\/L$/i.test(token));
  const info = { preview };
  for (const token of tokens.slice(1)) {
    const output = token.replaceAll('"', '').match(/^\/(UNILOG|LOG)\+?:(.+)$/i);
    if (!output) continue;
    try {
      info.logPath = absoluteFolder(output[2], '日志文件');
      info.unicodeLog = output[1].toUpperCase() === 'UNILOG';
    } catch { /* A relative log path cannot be reliably resolved for another process. */ }
  }
  if (options.some(token => /^\/(?:JOB:|NOSD$|NODD$)/i.test(token))) return info;
  try {
    return { ...info, source: absoluteFolder(source, '源文件夹'), target: absoluteFolder(target, '目标文件夹') };
  } catch {
    return info;
  }
}

async function scanProcesses() {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$session = (Get-Process -Id $PID).SessionId',
    `$rows = @(Get-CimInstance Win32_Process -Filter "Name = 'robocopy.exe' AND SessionId = $session" |`,
    'Select-Object ProcessId, CommandLine, @{n="Started"; e={$_.CreationDate.ToUniversalTime().ToString("o")}})',
    'ConvertTo-Json -InputObject $rows -Compress',
  ].join("\n");
  const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 5000, maxBuffer: 2 * 1024 * 1024,
  });
  const rows = JSON.parse(stdout);
  return rows.map(row => ({
    ...externalPaths(row.CommandLine),
    id: 'external-' + row.ProcessId + '-' + row.Started,
    pid: row.ProcessId,
    startedAt: row.Started,
    started: Date.parse(row.Started) || null,
    state: 'external',
  }));
}

async function stopExternal(job) {
  if (!Number.isSafeInteger(job.pid) || job.pid < 1 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(job.startedAt)) {
    throw new Error('无法确认外部进程的身份，请刷新后重试。');
  }
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$session = (Get-Process -Id $PID).SessionId',
    `$targetPid = ${job.pid}`,
    `$expected = [DateTime]::ParseExact('${job.startedAt}', 'o', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)`,
    'try { $process = [Diagnostics.Process]::GetProcessById($targetPid) } catch [ArgumentException] { "gone"; exit }',
    'try {',
    '  $null = $process.Handle',
    '  if ($process.HasExited) { "gone"; exit }',
    '  $actual = $process.StartTime.ToUniversalTime()',
    '  if ($process.ProcessName -ne "robocopy" -or $process.SessionId -ne $session -or [Math]::Abs($actual.Ticks - $expected.Ticks) -ge 10) {',
    '    "changed"; exit',
    '  }',
    '  $process.Kill()',
    '  if ($process.WaitForExit(5000)) { "stopped" } else { "timeout" }',
    '} catch {',
    '  if ($process.HasExited) { "gone" } else { throw }',
    '} finally { $process.Dispose() }',
  ].join('\n');
  let result;
  try {
    const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 8000,
    });
    result = stdout.trim();
  } catch {
    throw new Error('Windows 未能停止这个外部 Robocopy。请确认当前会话有权限操作该进程。');
  }
  if (result === 'stopped' || result === 'gone') return result;
  if (result === 'changed') throw new Error('这个进程的身份已变化。请刷新后重新选择。');
  throw new Error('尚未确认外部进程已退出，请刷新状态。');
}

async function tailLog(logPath, { unicode = true, since = 0, locale = '' } = {}) {
  let handle;
  try {
    if (since && !(await fs.stat(logPath)).isFile()) return '';
    handle = await fs.open(logPath, 'r');
    const { size, mtimeMs } = await handle.stat();
    if (mtimeMs + 2000 < since) return '';
    const end = unicode ? size - size % 2 : size;
    const start = Math.max(0, end - 32000);
    const buffer = Buffer.alloc(end - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const bytes = buffer.subarray(0, unicode ? bytesRead - bytesRead % 2 : bytesRead);
    let output;
    if (unicode) output = bytes.toString('utf16le');
    else {
      try { output = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch {
        const fallback = /^zh-(?:TW|HK)/i.test(locale) ? 'big5' : /^zh/i.test(locale) ? 'gb18030' : 'windows-1252';
        output = new TextDecoder(fallback).decode(bytes);
      }
    }
    output = output.replace(/^\uFEFF/, '');
    if (!start) return output;
    return output.replace(/^[^\r\n]*[\r\n]+/, '');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  } finally {
    await handle?.close();
  }
}

module.exports = { robocopy, validate, canonicalFolder, folderKey, overlaps, copyArguments, launch, scanProcesses, stopExternal, tailLog };
