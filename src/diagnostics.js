'use strict';

const { createReadStream } = require('node:fs');
const { createInterface } = require('node:readline');

const reasons = {
  2: '找不到指定文件',
  3: '找不到指定路径',
  5: '访问被拒绝',
  32: '文件正在被其他进程使用',
  33: '文件的一部分被锁定',
  53: '找不到网络路径',
  64: '网络连接已中断',
  67: '找不到网络共享名',
  112: '磁盘空间不足',
  123: '文件名、目录名或卷标语法不正确',
  206: '文件名或扩展名太长',
};

async function readFailure(logPath, exitCode) {
  const groups = new Map();
  let failureCount;
  let previous;
  const input = createReadStream(logPath, { encoding: 'utf16le' });
  const reader = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const raw of reader) {
      const line = raw.trim();
      const match = line.match(/(?:\bERROR|错误)\s+(\d+)\s+\(0x[\da-f]+\)\s*(.*)/i);
      if (match) {
        const code = Number(match[1]);
        const context = match[2];
        const location = context.match(/(?:[a-z]:\\|\\\\).+$/i);
        const file = location?.[0];
        const group = groups.get(code) ?? { code, reason: reasons[code], paths: new Set(), examples: [], attempts: 0 };
        group.attempts++;
        if (file && !group.paths.has(file)) {
          group.paths.add(file);
          if (group.examples.length < 5) {
            group.examples.push({ file, operation: context.slice(0, location.index).trim() });
          }
        }
        groups.set(code, group);
        previous = group;
        continue;
      }
      if (previous && line && !previous.native && !/^\d{4}[/.-]\d/.test(line)) previous.native = line;
      previous = undefined;
      const stats = line.match(/^(?:Files|文件)[：:]\s+(.+)$/i);
      const values = stats?.[1].trim().split(/\s+/);
      if (values?.length === 6 && /^\d+$/.test(values[4])) failureCount = Number(values[4]);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  } finally {
    reader.close();
  }
  const issues = [...groups.values()].map(({ paths, ...group }) => ({
    ...group, reason: group.reason || group.native || 'Windows 返回复制错误', files: paths.size,
  })).sort((a, b) => (b.files || b.attempts) - (a.files || a.attempts));
  const reason = issues.map(issue => issue.reason).join('、');
  const prefix = failureCount ? failureCount + ' 个文件复制失败' : 'Robocopy 复制失败';
  return {
    exitCode, failureCount, issues,
    summary: prefix + (reason ? '：' + reason : '') + (Number.isInteger(exitCode) ? '（退出码 ' + exitCode + '）' : ''),
  };
}

module.exports = { readFailure };
