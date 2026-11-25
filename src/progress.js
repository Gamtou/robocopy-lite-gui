'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { StringDecoder } = require('node:string_decoder');
const path = require('node:path').win32;

function logEntry(line) {
  const percentage = line.trim().match(/^(\d{1,3})(?:[.,](\d+))?\s*%$/);
  if (percentage) {
    const value = Number(percentage[1] + '.' + (percentage[2] ?? '0'));
    return value <= 100 ? { percent: value } : null;
  }
  const columns = line.split('\t').map(value => value.trim()).filter(Boolean);
  const file = columns.at(-1);
  const size = columns.at(-2)?.match(/^(\d+(?:[.,]\d+)?)\s*([kmgtpe])?$/i);
  if (!file || !size || columns.some(value => /^\*\s*(?:EXTRA|多余)/i.test(value))) return null;
  const power = size[2] ? 'kmgtpe'.indexOf(size[2].toLowerCase()) + 1 : 0;
  return { file, bytes: Number(size[1].replace(',', '.')) * 1024 ** power };
}

function lines(consume) {
  let pending = '';
  return (text, flush = false) => {
    const records = (pending + text).split(/[\r\n]+/);
    pending = records.pop() || '';
    for (const line of records) if (line) consume(line);
    if (flush && pending) {
      consume(pending);
      pending = '';
    }
  };
}

async function scanPlan(file, source, signal) {
  let bytes = 0;
  let count = 0;
  const root = path.resolve(source).replace(/\\+$/, '').toLowerCase() + '\\';
  const feed = lines(line => {
    const entry = logEntry(line);
    if (entry?.file?.toLowerCase().startsWith(root)) {
      bytes += entry.bytes;
      count++;
    }
  });
  for await (const text of createReadStream(file, { encoding: 'utf16le', signal })) feed(text);
  feed('', true);
  return { bytes, count };
}

function monitorLog(file, offset, consume) {
  const decode = new StringDecoder('utf16le');
  const feed = lines(consume);
  let reading;
  async function read() {
    let handle;
    try {
      handle = await fs.open(file, 'r');
      const { size } = await handle.stat();
      const end = size - size % 2;
      while (offset < end) {
        const buffer = Buffer.allocUnsafe(Math.min(65536, end - offset));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        feed(decode.write(buffer.subarray(0, bytesRead)));
      }
    } catch {
      // The first progress sample can occur before Robocopy creates the log.
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  const sample = () => {
    if (!reading) reading = read().finally(() => { reading = undefined; });
    return reading;
  };
  const timer = setInterval(sample, 350);
  return async () => {
    clearInterval(timer);
    await reading;
    await sample();
    feed(decode.end(), true);
  };
}

function rateTracker() {
  let at = Date.now();
  let last = 0;
  let speed;
  let latest;
  return bytes => {
    const now = Date.now();
    if (bytes < last) {
      at = now;
      last = bytes;
      speed = latest = undefined;
    } else if (now - at >= 700 && bytes > last) {
      const measured = (bytes - last) * 1000 / (now - at);
      speed = speed ? speed * 0.65 + measured * 0.35 : measured;
      latest = at = now;
      last = bytes;
    }
    return { speed, speedAt: latest };
  };
}

function singleReporter(plan, source, report) {
  const prefix = path.resolve(source).replace(/\\+$/, '').toLowerCase() + '\\';
  let current;
  let currentPercent = null;
  let bytesDone = 0;
  let filesDone = 0;
  const rate = rateTracker();
  return line => {
    const entry = logEntry(line);
    if (!entry) return;
    if (entry.file) {
      if (!entry.file.toLowerCase().startsWith(prefix)) return;
      if (current && (currentPercent === 100 || !current.bytes)) {
        bytesDone += current.bytes;
        filesDone++;
      }
      current = entry;
      currentPercent = null;
    } else if (current) {
      currentPercent = entry.percent;
    }
    if (!current) return;
    const fileTransferred = current.bytes * (currentPercent ?? 0) / 100;
    const transferred = bytesDone + fileTransferred;
    const processed = filesDone + (currentPercent === 100 ? 1 : 0);
    const ratio = plan?.bytes > 0 ? transferred / plan.bytes : plan?.count > 0 ? processed / plan.count : null;
    report({
      stage: 'copying',
      file: current.file,
      filePercent: currentPercent,
      fileBytes: current.bytes,
      fileTransferred,
      overall: ratio === null ? null : Math.min(99.9, ratio * 100),
      transferred, totalBytes: plan?.bytes, processed, totalFiles: plan?.count, ...rate(transferred),
    });
  };
}

function externalProgress(text) {
  let file = null;
  let filePercent = null;
  for (const line of text.split(/[\r\n]+/)) {
    if (/^\s*(?:Started|开始时间|开始于)\s*:/i.test(line)) {
      file = null;
      filePercent = null;
    }
    const entry = logEntry(line);
    if (entry?.file) {
      file = entry.file;
      filePercent = null;
    } else if (file && entry?.percent != null) {
      filePercent = entry.percent;
    }
  }
  return { stage: 'external', file, filePercent };
}

module.exports = { logEntry, scanPlan, monitorLog, singleReporter, externalProgress, rateTracker };
