'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const api = window.backup;
  const page = $('logs-page');
  const options = $('log-task');
  const filter = $('log-status');
  const search = $('log-search');
  let entries = [];
  let selected;
  let cachedList = '';
  let cachedFilters = '';
  let loadedOutput = '';
  let outputRequest = 0;
  let updating = false;

  const statusLabels = {
    syncing: '同步中', preview: '预览中', done: '已完成', differences: '已完成 · 有差异',
    failed: '失败', error: '失败', offline: '已暂停 · 文件夹不可用', stopped: '已停止',
    external: '外部运行中', unknown: '外部已结束 · 结果未知', conflict: '待处理冲突',
  };
  const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '';
  const keyOf = entry => entry.taskId || 'app';
  const active = entry => ['syncing', 'preview', 'external'].includes(entry.state);
  const issue = entry => ['failed', 'error', 'offline', 'conflict'].includes(entry.state);
  const status = entry => entry.preview && entry.state === 'done' ? '预览完成' : statusLabels[entry.state] || entry.state;

  function node(tag, text, className) {
    const result = document.createElement(tag);
    if (text) result.textContent = text;
    if (className) result.className = className;
    return result;
  }

  function field(id, text) {
    const result = $(id);
    result.textContent = text || '';
    result.hidden = !text;
  }

  function show(showing) {
    page.hidden = !showing;
    $('tasks-page').hidden = showing;
    $('logs-button').hidden = showing;
    $('tasks-button').hidden = !showing;
    $('new-job').hidden = showing;
    $('settings-button').hidden = showing;
    $('page-title').textContent = showing ? '日志' : '同步任务';
    if (showing) {
      void refresh();
      search.focus();
    } else {
      outputRequest++;
      loadedOutput = '';
      $('logs-button').focus();
    }
  }

  function badge(entry) {
    const stage = node('span', status(entry), 'state');
    stage.dataset.state = entry.state;
    return stage;
  }

  function entryButton(entry) {
    const control = node('button', '', 'log-record');
    control.type = 'button';
    control.setAttribute('aria-pressed', String(entry.id === selected));
    control.append(node('strong', entry.title || entry.taskName), badge(entry),
      node('time', time(entry.ended || entry.started), 'task-time'));
    if (entry.error || entry.lastFile) control.append(node('span', entry.error || entry.lastFile, 'record-file'));
    control.addEventListener('click', () => {
      selected = entry.id;
      render();
    });
    return control;
  }

  function renderOptions() {
    const groups = [...new Map(entries.map(entry => [keyOf(entry), entry.taskName])).entries()];
    const key = JSON.stringify(groups);
    if (key === cachedFilters) return;
    cachedFilters = key;
    const current = options.value;
    options.replaceChildren(new Option('所有任务', ''),
      ...groups.map(([id, name]) => new Option(name, id)));
    if (groups.some(([id]) => id === current)) options.value = current;
  }

  function matches(entry) {
    if (options.value && keyOf(entry) !== options.value) return false;
    if (filter.value === 'errors' && !issue(entry)) return false;
    if (filter.value === 'active' && !active(entry)) return false;
    if (filter.value === 'done' && !['done', 'differences'].includes(entry.state)) return false;
    if (filter.value === 'stopped' && entry.state !== 'stopped') return false;
    const query = search.value.trim().toLocaleLowerCase();
    return !query || [entry.title, entry.taskName, entry.source, entry.target, entry.error, entry.lastFile]
      .some(value => value?.toLocaleLowerCase().includes(query));
  }

  function pathRow(entry) {
    if (!entry.source && !entry.target) return [];
    const list = node('dl', '', 'routes');
    list.append(node('dt', '来源'), node('dd', entry.source || '路径不可读'),
      node('dt', '目标'), node('dd', entry.target || '路径不可读'));
    return [list];
  }

  async function output(entry) {
    if (!entry || entry.kind === 'event') {
      field('log-output', '');
      outputRequest++;
      loadedOutput = '';
      return;
    }
    const key = entry.id + '|' + entry.state;
    if (key !== loadedOutput) field('log-output', '正在读取日志…');
    else if (!active(entry)) return;
    const request = ++outputRequest;
    try {
      const content = await api.diagnosticLog(entry.id);
      if (request !== outputRequest || page.hidden) return;
      loadedOutput = key;
      const readable = content.split(/[\r\n]+/).filter(line => !/^\s*\d{1,3}(?:[.,]\d+)?\s*%\s*$/.test(line)).join('\n');
      field('log-output', readable || '这条记录暂时没有可读的 Robocopy 输出。');
    } catch (error) {
      if (request === outputRequest) field('log-output', error.message);
    }
  }

  function render() {
    renderOptions();
    const shown = entries.filter(matches);
    if (!shown.some(entry => entry.id === selected)) selected = shown[0]?.id;
    const current = shown.find(entry => entry.id === selected);
    const key = JSON.stringify([shown, selected]);
    if (key !== cachedList) {
      cachedList = key;
      $('log-records').replaceChildren(...shown.map(entryButton));
      $('logs-empty').hidden = shown.length > 0;
      $('log-count').textContent = shown.length ? shown.length + ' 条' : '';
      $('log-title').textContent = current?.title || current?.taskName || '日志详情';
      $('log-summary').textContent = current ?
        [status(current), time(current.ended || current.started), Number.isInteger(current.code) ? '退出码 ' + current.code : '']
          .filter(Boolean).join(' · ') : '选择一条记录，查看出错位置和 Robocopy 输出。';
      $('log-paths').replaceChildren(...(current ? pathRow(current) : []));
      field('log-last-file', current?.lastFile ? '最后报告的文件 · ' + current.lastFile : '');
      field('log-error', current?.error);
    }
    void output(current);
  }

  async function refresh() {
    if (page.hidden || updating) return;
    updating = true;
    try {
      const result = await api.logsSnapshot();
      if (page.hidden) return;
      entries = result.sort((left, right) => (right.ended || right.started || 0) - (left.ended || left.started || 0));
      render();
    } catch (error) {
      field('log-error', error.message);
    } finally {
      updating = false;
    }
  }

  $('logs-button').addEventListener('click', () => show(true));
  $('tasks-button').addEventListener('click', () => show(false));
  $('open-logs-folder').addEventListener('click', async () => {
    try {
      const error = await api.openLogsFolder();
      if (error) field('log-error', error);
    } catch (error) {
      field('log-error', error.message);
    }
  });
  options.addEventListener('change', render);
  filter.addEventListener('change', render);
  search.addEventListener('input', render);
  setInterval(refresh, 1000);
})();
