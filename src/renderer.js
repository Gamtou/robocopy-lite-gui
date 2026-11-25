'use strict';

const $ = id => document.getElementById(id);
const api = window.backup;
const formDialog = $('job-form');
const detailDialog = $('job-detail');
const settingsDialog = $('settings-dialog');
const form = $('backup-form');
let data = { tasks: [], external: [], settings: {} };
let editing;
let takingOver;
let viewing;
let selectedRun;
let runningAction = false;
let previousView = '';
let previousDetail = '';
let globalActionError = '';
const progressViews = new Map();

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(label, callback) {
  const node = element('button', label);
  node.type = 'button';
  node.addEventListener('click', callback);
  return node;
}

function message(id, text) {
  const node = $(id);
  node.textContent = text || '';
  node.hidden = !text;
}

function errorText(error) {
  return error.message.replace(/^Error invoking remote method .*?: (?:Error: )?/, '');
}

function date(value) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

const labels = {
  paused: '已暂停', watching: '监测中', syncing: '正在同步', offline: '已暂停 · 文件夹不可用',
  conflict: '存在待处理冲突', error: '同步失败', preview: '预览中',
  external: '运行中', unknown: '已结束 · 结果未知', done: '已完成', stopped: '已停止', differences: '已完成 · 有差异',
  failed: '有文件复制失败',
};

function tag(state, preview = false) {
  const badge = element('span', preview && state === 'done' ? '预览完成' : labels[state] || state, 'state');
  badge.dataset.state = state;
  return badge;
}

function routes(source, target, two = false) {
  const list = element('dl', '', 'routes');
  list.append(
    element('dt', two ? '左侧' : '来源'), element('dd', source || '路径不可读'),
    element('dt', two ? '右侧' : '备份'), element('dd', target || '路径不可读'),
  );
  return list;
}

function progressPanel(id) {
  const panel = element('div', '', 'task-progress');
  const heading = element('div', '', 'progress-heading');
  const title = element('span');
  const metric = element('span');
  const bar = element('progress');
  const file = element('p', '', 'current-file');
  const fileBar = element('progress', '', 'file-progress');
  const timing = element('p', '', 'progress-timing');
  heading.append(title, metric);
  panel.append(heading, bar, file, fileBar, timing);
  panel.hidden = true;
  progressViews.set(id, { panel, title, metric, bar, file, fileBar, timing, previous: '' });
  return panel;
}

function meter(node, name, value) {
  node.max = 100;
  node.setAttribute('aria-label', name);
  if (Number.isFinite(value)) node.value = value;
  else node.removeAttribute('value');
}

function readableBytes(value) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + ' ' + units[i];
}

function duration(seconds) {
  const whole = Math.max(0, Math.ceil(seconds));
  if (whole < 60) return whole + ' 秒';
  const minutes = Math.floor(whole / 60);
  return minutes < 60 ? minutes + ' 分 ' + whole % 60 + ' 秒' :
    Math.floor(minutes / 60) + ' 小时 ' + minutes % 60 + ' 分';
}

function showProgress(id, progress, isExternal = false, started) {
  const view = progressViews.get(id);
  if (!view) return;
  const elapsed = progress && started ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : undefined;
  const key = JSON.stringify([progress, elapsed]);
  if (key === view.previous) return;
  view.previous = key;
  view.panel.hidden = !progress;
  if (!progress) return;
  const { stage, file, filePercent, overall, transferred, totalBytes, handled, total,
    fileBytes, fileTransferred, totalFiles, processed, speed, speedAt } = progress;
  const phase = {
    scanning: '正在扫描待同步文件',
    preview: '正在预览',
    copying: '正在复制',
    comparing: '正在核对两侧文件',
    verifying: '正在验证当前文件',
    external: file ? '外部日志 · 文件进度' : '等待外部 Robocopy 报告进度',
    unavailable: '外部任务暂未提供可读进度',
  };
  const value = isExternal ? filePercent : overall;
  const name = isExternal ? phase[stage] : Number.isFinite(total) && total > 0 ? '本轮处理项' :
    Number.isFinite(overall) ? '整轮备份进度（估算）' : phase[stage];
  view.title.textContent = name || '';
  const percent = Number.isFinite(value) ? value.toFixed(1) + '%' : '';
  const units = total > 0 ? handled + ' / ' + total + ' 项' : totalBytes > 0 && Number.isFinite(transferred) ?
    readableBytes(transferred) + ' / ' + readableBytes(totalBytes) : '';
  const fileCount = totalFiles > 0 ? Math.min(processed ?? 0, totalFiles) + ' / ' + totalFiles + ' 个文件' : '';
  view.metric.textContent = [percent, units, fileCount].filter(Boolean).join(' · ');
  view.bar.hidden = stage === 'unavailable';
  meter(view.bar, name || '备份进度', value);
  view.file.hidden = !file;
  const fileSize = fileBytes > 0 && Number.isFinite(fileTransferred) ?
    readableBytes(fileTransferred) + ' / ' + readableBytes(fileBytes) : '';
  const fileState = file ? [file, !isExternal && Number.isFinite(filePercent) ? filePercent.toFixed(1) + '%' : '', fileSize] : [];
  view.file.textContent = file ? (isExternal ? '日志报告的文件 · ' : '当前文件 · ') + fileState.filter(Boolean).join(' · ') : '';
  view.fileBar.hidden = isExternal || !file || !Number.isFinite(filePercent);
  meter(view.fileBar, '当前文件进度', filePercent);
  const timing = elapsed === undefined ? [] : ['已用时 ' + duration(elapsed)];
  if (stage === 'copying' && speed > 0 && Date.now() - speedAt < 6500) {
    timing.push(readableBytes(speed) + '/s');
    const fileOnly = total > 0 || !totalBytes;
    const remaining = fileOnly ? fileBytes - fileTransferred : totalBytes - transferred;
    if (remaining > 0) timing.push((fileOnly ? '当前文件预计剩余 ' : '预计剩余 ') + duration(remaining / speed));
  }
  view.timing.hidden = !timing.length;
  view.timing.textContent = timing.join(' · ');
}

async function action(callback, errorId = 'global-error') {
  if (runningAction) return false;
  runningAction = true;
  try {
    if (errorId === 'global-error') globalActionError = '';
    message(errorId, '');
    await callback();
    await refresh();
    return true;
  } catch (error) {
    const text = errorText(error);
    if (errorId === 'global-error') globalActionError = text;
    message(errorId, text);
    return false;
  } finally {
    runningAction = false;
  }
}

function updateMode() {
  const two = form.elements.mode.value === 'two';
  $('source-label').textContent = two ? '左侧文件夹' : '源文件夹';
  $('target-label').textContent = two ? '右侧文件夹' : '备份文件夹';
  $('mode-hint').textContent = two ? '两边的新增和修改都会同步。单边删除会保留对端文件，同名冲突会等待你处理。' :
    '只从源复制到备份文件夹。目标端较新的同名文件和已备份的历史文件会保留。';
}

function updatePathNote() {
  const before = editing?.config;
  const after = form.elements;
  const changed = before && (before.source !== after.source.value || before.target !== after.target.value || before.mode !== after.mode.value);
  message('path-change', changed ? '原来：' + before.source + ' → ' + before.target +
    '\n保存后使用新配置。原位置的文件保留。双向任务会重新建立配对。' :
    editing?.hold?.includes('位置已变化') ? '保存会重新绑定这两个文件夹，请核对盘符对应的位置。' : '');
}

function updateExtensionTags() {
  const input = form.elements.excludeExtensions;
  const container = $('extension-tags');
  const values = input.value.split(/[,，;；\s]+/).filter(Boolean);
  const tokens = new Map(values.map(value => [value.toLowerCase().replace(/^(?:\*\.|\.)/, ''), value]));
  container.hidden = !tokens.size;
  container.replaceChildren(...[...tokens].map(([extension]) => {
    const tag = button(extension + ' ×', () => {
      input.value = values.filter(value => value.toLowerCase().replace(/^(?:\*\.|\.)/, '') !== extension).join(', ');
      updateExtensionTags();
      input.focus();
    });
    tag.setAttribute('aria-label', '移除排除规则 ' + extension);
    return tag;
  }));
}

function openForm(task = null, job = null) {
  editing = task;
  takingOver = job;
  const config = task?.config || (job ? { ...job, name: '外部 Robocopy ' + job.pid } : {});
  form.reset();
  const entries = {
    source: config.source || '', target: config.target || '', name: config.name || '', mode: config.mode || 'one',
    speed: config.speed || 'normal', excludeFiles: config.excludeFiles?.join('\n') || '',
    excludeDirs: config.excludeDirs?.join('\n') || '',
    excludeExtensions: config.excludeExtensions?.join(', ') || '',
  };
  for (const [key, value] of Object.entries(entries)) form.elements[key].value = value;
  form.elements.resume.checked = config.resume !== false;
  form.elements.excludeMetadata.checked = config.excludeMetadata === true;
  form.elements.excludeDotEntries.checked = config.excludeDotEntries === true;
  const hasRules = config.excludeMetadata || config.excludeDotEntries || config.excludeExtensions?.length ||
    config.excludeFiles?.length || config.excludeDirs?.length;
  $('exclusion-rules').open = Boolean(hasRules);
  updateExtensionTags();
  $('form-title').textContent = job ? '接管外部任务' : task ? '编辑任务' : '新建任务';
  $('save-start').hidden = Boolean(task || job);
  $('save-only').textContent = job ? '接管并保存' : '保存';
  $('save-only').classList.toggle('primary', Boolean(task || job));
  $('advanced').open = false;
  message('form-feedback', '');
  message('adopt-note', job ? '保存后会结束仍在运行的原进程，现有文件保留。接管使用本表单的同步规则，任务保存为暂停状态。' : '');
  updateMode();
  updatePathNote();
  formDialog.showModal();
  $('name').focus();
}

async function saveTask(startNow) {
  if (!form.reportValidity() || runningAction) return;
  const config = { ...Object.fromEntries(new FormData(form)), resume: form.elements.resume.checked,
    excludeMetadata: form.elements.excludeMetadata.checked, excludeDotEntries: form.elements.excludeDotEntries.checked };
  const done = await action(async () => {
    const id = takingOver ? await api.adoptExternal(takingOver.id, config) :
      await api.configure(editing?.id ?? null, config);
    // Close once the task exists so a failed start cannot create a duplicate.
    formDialog.close();
    if (startNow) {
      try { await api.start(id); }
      catch (error) {
        globalActionError = '任务已保存。' + errorText(error);
        message('global-error', globalActionError);
      }
    }
  }, 'form-feedback');
  if (done && formDialog.open) formDialog.close();
}

function card(task) {
  const { config } = task;
  const two = config.mode === 'two';
  const container = element('article', '', 'card');
  const head = element('div', '', 'job-head');
  head.append(element('strong', config.name), tag(task.state));
  const mode = element('div', two ? '双向同步' : '单向累计备份', 'task-mode');
  const footer = element('div', '', 'task-footer');
  const last = element('span', task.lastSync ? '上次同步 ' + date(task.lastSync) : '尚未完成同步', 'task-time');
  const controls = element('div', '', 'job-actions');
  if (task.enabled || task.state === 'preview') {
    controls.append(button('暂停', () => action(() => api.pause(task.id))));
  } else {
    const start = button(task.identity || task.hold || task.origin === 'external' ? '继续' : '开始', () => action(() => api.start(task.id)));
    start.className = 'primary';
    controls.append(start, button('编辑', () => openForm(task)));
  }
  controls.append(button('详情', () => openDetail(task.id)));
  footer.append(last, controls);
  container.append(head, mode, routes(config.source, config.target, two));
  container.append(progressPanel(task.id));
  if (task.error) container.append(element('p', task.error, 'notice'));
  container.append(footer);
  return container;
}

function externalCard(job) {
  const container = element('article', '', 'card');
  const head = element('div', '', 'job-head');
  head.append(element('strong', job.preview ? '外部预览' : '外部任务'), tag(job.state));
  const controls = element('div', '', 'job-actions');
  if (job.ended) {
    controls.append(button('接管为持续任务', () => openForm(null, job)));
  } else {
    controls.append(
      button('暂停并接管', () => {
        if (!job.source || !job.target) {
          openForm(null, job);
          return;
        }
        if (window.confirm('结束这个外部进程，并将这组路径保存为暂停的单向累计备份？\n已同步的文件会保留。正在写入的文件可能不完整。')) {
          void action(() => api.adoptExternal(job.id));
        }
      }),
      button('编辑并接管', () => openForm(null, job)),
      button('取消', () => {
        if (window.confirm('取消这个外部 Robocopy？\n这会结束该进程。已同步的文件会保留，正在写入的文件可能不完整。')) {
          void action(() => api.cancelExternal(job.id));
        }
      }),
    );
  }
  const footer = element('div', '', 'task-footer');
  footer.append(element('time', job.ended ? '结束于 ' + date(job.ended) :
    job.started ? '开始于 ' + date(job.started) : '', 'task-time'), controls);
  container.append(head, routes(job.source, job.target), progressPanel(job.id), footer);
  return container;
}

function render() {
  const current = JSON.stringify(data, (key, value) => key === 'progress' ? undefined : value);
  message('global-error', globalActionError || data.storageError);
  if (current !== previousView) {
    previousView = current;
    const enabled = data.tasks.filter(task => task.enabled).length;
    const count = data.tasks.length + data.external.length;
    $('running-count').textContent = count ? count + ' 项 · ' + enabled + ' 项持续同步已启用' : '';
    progressViews.clear();
    $('task-list').replaceChildren(...data.tasks.map(card), ...data.external.map(externalCard));
    $('tasks-empty').hidden = count > 0;
    const scanMessages = { checking: '正在检查系统任务…', unavailable: '目前无法检查其他程序启动的 Robocopy。' };
    message('scan-status', scanMessages[data.scanState]);
  }
  for (const task of data.tasks) showProgress(task.id, task.progress, false, task.started);
  for (const job of data.external) {
    const state = job.ended ? null : job.progress || { stage: job.logPath ? 'external' : 'unavailable' };
    showProgress(job.id, state, true, job.started);
  }
}

function openDetail(id) {
  viewing = id;
  selectedRun = null;
  previousDetail = '';
  $('detail-log').textContent = '';
  detailDialog.showModal();
  void renderDetail();
}

function conflictCard(task, item) {
  const node = element('div', '', 'conflict-row');
  const actions = element('div', '', 'job-actions');
  const options = { left: '保留左侧', right: '保留右侧', both: '两份都留' };
  for (const [key, label] of Object.entries(options)) {
    const control = button(label, () => {
      const detail = key === 'both' ? '将保留两份内容，并在两侧生成右侧副本。' :
        '使两侧都使用所选内容，另一侧当前版本会被覆盖。';
      if (window.confirm(item.name + '\n' + detail)) {
        void action(async () => {
          await api.resolveConflict(task.id, item.key, key);
          message('detail-error', task.enabled ? '已提交处理。' : '已提交处理，继续任务时应用。');
        }, 'detail-error');
      }
    });
    actions.append(control);
  }
  node.append(element('strong', item.name), actions);
  return node;
}

function runRow(run) {
  const row = element('div', '', 'history-row');
  row.append(tag(run.state, run.preview), element('time', date(run.ended || run.started), 'task-time'));
  if (run.error) row.append(element('span', run.error, 'task-time'));
  row.append(button('查看日志', () => {
    selectedRun = run.id;
    void refreshLog();
  }));
  return row;
}

async function refreshLog() {
  const id = viewing;
  const run = selectedRun;
  $('log-section').hidden = !run;
  if (!run || !detailDialog.open) return;
  try {
    const log = await api.log(id, run);
    if (viewing === id && selectedRun === run) $('detail-log').textContent = log || '暂时没有日志';
  } catch (error) {
    if (viewing === id && selectedRun === run) $('detail-log').textContent = errorText(error);
  }
}

async function renderDetail() {
  if (!detailDialog.open) return;
  const task = data.tasks.find(item => item.id === viewing);
  if (!task) {
    detailDialog.close();
    return;
  }
  const key = JSON.stringify(task, (field, value) => field === 'progress' ? undefined : value);
  if (previousDetail !== key) {
    previousDetail = key;
    $('detail-title').textContent = task.config.name;
    $('detail-status').textContent = labels[task.state];
    $('detail-paths').replaceChildren(routes(task.config.source, task.config.target, task.config.mode === 'two'));
    message('detail-error', task.error);
    $('conflict-section').hidden = !task.conflicts.length;
    $('conflicts').replaceChildren(...task.conflicts.map(item => conflictCard(task, item)));
    $('preview').hidden = task.enabled || task.state === 'preview' || task.config.mode === 'two';
    const rows = task.history.map(runRow);
    if (task.currentRun) {
      const current = runRow({ id: task.currentRun, started: task.started, state: task.state });
      rows.unshift(current);
    }
    $('history').replaceChildren(...(rows.length ? rows : [element('p', '暂无执行记录', 'hint')]));
  }
  await refreshLog();
}

async function refresh() {
  try {
    data = await api.snapshot();
    $('app-version').textContent = `v${data.version}`;
    render();
    await renderDetail();
  } catch (error) {
    message('global-error', errorText(error));
  }
}

$('new-job').addEventListener('click', () => openForm());
$('close-form').addEventListener('click', () => formDialog.close());
$('close-detail').addEventListener('click', () => detailDialog.close());
$('close-settings').addEventListener('click', () => settingsDialog.close());
for (const dialog of [formDialog, detailDialog, settingsDialog]) {
  dialog.addEventListener('cancel', event => { if (runningAction) event.preventDefault(); });
}
form.addEventListener('submit', event => {
  event.preventDefault();
  void saveTask(!editing && !takingOver);
});
$('save-only').addEventListener('click', () => saveTask(false));
form.addEventListener('input', () => {
  updateMode();
  updatePathNote();
});
form.elements.excludeExtensions.addEventListener('input', updateExtensionTags);
for (const control of document.querySelectorAll('[data-browse]')) {
  control.addEventListener('click', async () => {
    try {
      const folder = await api.chooseFolder();
      if (folder) $(control.dataset.browse).value = folder;
      updatePathNote();
    } catch (error) {
      message('form-feedback', errorText(error));
    }
  });
}
$('delete-task').addEventListener('click', () => {
  const task = data.tasks.find(item => item.id === viewing);
  if (task && window.confirm('取消并删除「' + task.config.name + '」？\n任务会停止，两个文件夹内已有的文件会保留。')) {
    void action(() => api.remove(task.id), 'detail-error');
  }
});
$('preview').addEventListener('click', () => action(() => api.preview(viewing), 'detail-error'));
$('settings-button').addEventListener('click', () => {
  for (const option of $('settings-form').querySelectorAll('input')) option.checked = data.settings[option.name];
  message('settings-error', '');
  settingsDialog.showModal();
});
$('settings-form').addEventListener('submit', event => {
  event.preventDefault();
  const options = Object.fromEntries(new FormData(event.target));
  const config = Object.fromEntries(Object.keys(options).map(key => [key, true]));
  void action(async () => {
    await api.settings(config);
    settingsDialog.close();
  }, 'settings-error');
});
void refresh();
setInterval(refresh, 1000);
