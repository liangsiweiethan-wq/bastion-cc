const $ = (id) => document.getElementById(id);

const THEME_KEY = 'bastioncc.theme';

const applyTheme = (theme) => {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  const toggle = $('theme-toggle');
  if (!toggle) return;
  const action = next === 'dark' ? '切换浅色主题' : '切换深色主题';
  toggle.setAttribute('aria-label', action);
  toggle.setAttribute('title', action);
  const label = toggle.querySelector('.btn-label');
  if (label) label.textContent = next === 'dark' ? '深色' : '浅色';
};

const savedTheme = (() => {
  try { return localStorage.getItem(THEME_KEY); } catch { return null; }
})();
applyTheme(savedTheme === 'dark' ? 'dark' : 'light');

const CONFIG_KEY = 'ccrf:web-config';
const DRAFT_PREFIX = 'ccrf:web-draft:';
const LAST_SESSION_KEY = 'ccrf:web-last-session';

const state = {
  base: '',
  token: '',
  totp: '',
  session: '',
  search: '',
  sessionsCache: [],
  lastPrompt: '',
  cursor: 0,
  transcriptCursor: 0,
  generation: 0,
  run: null,
  streamController: null,
  autoStream: true,
  transcriptPending: false,
  transcriptReloadQueued: false,
  lastCompositionEndAt: null,
  connected: false,
  connectionOpen: true,
};

const api = async (path, options = {}) => {
  const headers = {
    ...(options.body ? { 'content-type': 'application/json' } : {}),
    ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
    ...(state.totp ? { 'x-ccrf-totp': state.totp } : {}),
  };
  const response = await fetch(`${state.base}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(body.error?.message || `HTTP ${response.status}`);
  }
  return body;
};

const showError = (error) => {
  $('error').textContent = error instanceof Error ? error.message : String(error || '');
};

const showNotice = (message) => {
  $('notice').textContent = message || '';
};

const TIME_LOCALE = 'zh-CN';
const clockFormat = new Intl.DateTimeFormat(TIME_LOCALE, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
const absoluteFormat = new Intl.DateTimeFormat(TIME_LOCALE, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
const relativeFormat = new Intl.RelativeTimeFormat(TIME_LOCALE, { numeric: 'auto' });
const TERMINAL_RUN = new Set(['completed', 'failed', 'cancelled', 'unknown']);
const EVENT_TONES = {
  SessionCreated: 'created',
  SessionUpdated: 'created',
  SnapshotCreated: 'created',
  RunQueued: 'queued',
  RunLeased: 'queued',
  RunStarted: 'running',
  ApprovalResponded: 'running',
  OutputChunk: 'output',
  ApprovalRequested: 'warn',
  RunCompleted: 'done',
  RunFailed: 'failed',
  RunCancelled: 'failed',
  RunUnknown: 'failed',
};

const eventTime = (iso) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return { clock: '', relative: '', absolute: String(iso || ''), iso: String(iso || '') };
  }
  const deltaSec = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(deltaSec);
  const unit = abs < 60 ? 'second' : abs < 3600 ? 'minute' : abs < 86400 ? 'hour' : abs < 86400 * 30 ? 'day' : null;
  const relative = unit
    ? relativeFormat.format(
      unit === 'second' ? deltaSec
        : unit === 'minute' ? Math.round(deltaSec / 60)
          : unit === 'hour' ? Math.round(deltaSec / 3600)
            : Math.round(deltaSec / 86400),
      unit,
    )
    : absoluteFormat.format(date);
  return {
    clock: clockFormat.format(date),
    relative,
    absolute: absoluteFormat.format(date),
    iso: date.toISOString(),
  };
};

const shortId = (value, head = 12) => {
  if (!value) return '';
  return value.length > head + 1 ? `${value.slice(0, head)}…` : value;
};

const confirmAction = ({ title, message, confirmLabel, dismissLabel = '返回' }) => new Promise((resolve) => {
  const dialog = $('confirm-dialog');
  if (!dialog || typeof dialog.showModal !== 'function') {
    resolve(window.confirm(message));
    return;
  }
  $('confirm-title').textContent = title;
  $('confirm-message').textContent = message;
  $('confirm-accept').textContent = confirmLabel;
  $('confirm-dismiss').textContent = dismissLabel;
  const finish = () => {
    dialog.removeEventListener('close', finish);
    resolve(dialog.returnValue === 'confirm');
  };
  dialog.addEventListener('close', finish);
  dialog.showModal();
});

const setConnectionUi = (connected) => {
  state.connected = connected;
  if (!connected) state.connectionOpen = true;
  const status = $('connection-status');
  let host = '';
  try { host = new URL(state.base || location.origin).host; } catch { host = ''; }
  status.dataset.state = connected ? 'online' : 'offline';
  status.textContent = connected ? (host ? `已连接 ${host}` : '已连接') : '未连接';
  const open = state.connectionOpen === true;
  $('connect-drawer').hidden = !open;
  $('connect-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
};

const draftKey = (sessionId) => `${DRAFT_PREFIX}${sessionId}`;

const saveDraft = () => {
  if (!state.session) return;
  try {
    const value = $('prompt-input').value;
    if (value) localStorage.setItem(draftKey(state.session), value);
    else localStorage.removeItem(draftKey(state.session));
  } catch {
    // Ignore storage quota issues.
  }
};

const restoreDraft = (sessionId) => {
  try {
    $('prompt-input').value = sessionId ? (localStorage.getItem(draftKey(sessionId)) || '') : '';
  } catch {
    $('prompt-input').value = '';
  }
};

const saveConnectionProfile = () => {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify({ base: state.base, lastProject: $('project-input').value.trim() }));
  } catch {
    // Ignore storage issues.
  }
};

const setSessionControlsEnabled = (enabled) => {
  for (const id of [
    'delete-session', 'disconnect', 'reconnect', 'refresh', 'toggle-stream',
    'start-run-btn', 'load-transcript', 'rename-toggle', 'fork-session', 'export-session',
  ]) {
    $(id).disabled = !enabled;
  }
};

const refreshMetrics = async () => {
  try {
    const result = await api('/v1/metrics');
    const metrics = result.data;
    if (!metrics) return;
    $('metrics-pill').textContent = `会话 ${metrics.totalSessions} · 轮次 ${metrics.totalRuns} · ~${metrics.estimatedTokens} Tokens · 缓存命中 ${metrics.cacheHitRate ?? 0}%`;
  } catch {
    // Ignore metrics failures prior to connection.
  }
};

const renderSession = (session) => {
  const name = $('active-session');
  name.textContent = session.title || session.sessionId;
  name.title = session.title && session.title !== session.sessionId
    ? `${session.title} · ${session.sessionId}`
    : session.sessionId;
  const projectTag = $('active-project-tag');
  projectTag.textContent = session.project || '';
  projectTag.hidden = !session.project;
  const claudeParts = [
    session.accountProfile || '',
    session.providerSessionId ? `Claude 续接 ${session.providerSessionId.slice(0, 8)}` : '',
  ].filter(Boolean);
  const claudeTag = $('active-claude-tag');
  claudeTag.textContent = claudeParts.join(' · ');
  claudeTag.hidden = claudeParts.length === 0;
  const statusEl = $('session-status');
  statusEl.textContent = session.status;
  statusEl.dataset.status = session.status || '';
  $('generation').textContent = String(session.generation);
  $('rename-title-input').value = session.title || '';
  $('rename-project-input').value = session.project || '';
  if (session.approvalMode) $('approval-mode').value = session.approvalMode;
  if (session.reasoningEffort) $('reasoning-effort').value = session.reasoningEffort;
  $('account-profile').value = session.accountProfile || '';
  state.generation = session.generation;
  if (session.currentRunId) {
    state.run = {
      runId: session.currentRunId,
      status: session.currentRunStatus || state.run?.status || 'unknown',
      leaseId: state.run?.runId === session.currentRunId ? state.run?.leaseId : undefined,
    };
  }
  renderRunState();
};

const renderRunState = () => {
  const run = state.run;
  const runEl = $('run-id');
  const copyBtn = $('copy-run-id');
  const runStatus = $('run-status');
  if (!run) {
    runEl.textContent = '无';
    runEl.removeAttribute('title');
    copyBtn.hidden = true;
    runStatus.hidden = true;
    runStatus.textContent = '';
    runStatus.dataset.status = '';
  } else {
    runEl.textContent = shortId(run.runId);
    runEl.title = run.runId;
    copyBtn.hidden = false;
    runStatus.hidden = false;
    runStatus.textContent = run.status || '';
    runStatus.dataset.status = run.status || '';
  }
  const cancel = $('cancel');
  const cancellable = Boolean(run?.leaseId) && !TERMINAL_RUN.has(run.status);
  cancel.hidden = !cancellable;
  cancel.disabled = !cancellable;
  cancel.classList.toggle('danger', cancellable);
  cancel.classList.toggle('secondary', !cancellable);
  $('approval-banner').hidden = !(run && run.status === 'awaiting_approval' && run.leaseId);
};

const appendEventItem = (event) => {
  const tone = EVENT_TONES[event.type] || 'created';
  const time = eventTime(event.createdAt);
  const item = document.createElement('li');
  item.className = 'event-item';
  item.dataset.tone = tone;
  const seq = document.createElement('span');
  seq.className = 'event-seq';
  seq.textContent = String(event.sequence);
  const name = document.createElement('span');
  name.className = 'event-name';
  name.textContent = String(event.type || '');
  const timeEl = document.createElement('time');
  timeEl.className = 'event-time';
  if (time.iso) timeEl.dateTime = time.iso;
  timeEl.title = time.iso ? `${time.absolute} · ${time.iso}` : time.absolute;
  const clock = document.createElement('span');
  clock.className = 'event-clock';
  clock.textContent = time.clock || time.absolute;
  const relative = document.createElement('span');
  relative.className = 'event-rel';
  relative.textContent = time.relative;
  timeEl.append(clock, relative);
  item.append(seq, name, timeEl);
  $('events').append(item);
  state.cursor = Math.max(state.cursor, event.sequence);
};

const refreshEvents = async () => {
  if (!state.session) return;
  const result = await api(`/v1/sessions/${encodeURIComponent(state.session)}/events?cursor=${state.cursor}`);
  for (const event of result.data || []) {
    appendEventItem(event);
  }
};

const renderEmptyState = (title = '欢迎使用 BastionCC（棱堡）网页控制台') => {
  const box = document.createElement('div');
  box.id = 'empty-state';
  box.className = 'empty-guide';
  const heading = document.createElement('h3');
  heading.textContent = title;
  const list = document.createElement('ol');
  for (const step of [
    '点击右上角「连接设置」，填入服务器地址与访问令牌后点击连接（本机同源访问会自动连入）。',
    '左侧点击「新建」填写项目与会话，或展开多设备授权签发 6位配对码。',
    '下方输入框支持 Enter 发送（中文输入法选词按 Enter 防误触）与 Shift+Enter 换行。',
  ]) {
    const li = document.createElement('li');
    li.textContent = step;
    list.append(li);
  }
  box.append(heading, list);
  $('transcript-view').replaceChildren(box);
};

const loadTranscript = async (reset = false) => {
  if (!state.session || !state.run?.runId) {
    if (reset) renderEmptyState('当前会话暂无对话记录');
    return;
  }
  const targetSession = state.session;
  const targetRunId = state.run.runId;
  if (reset) {
    state.transcriptCursor = 0;
    $('transcript-view').replaceChildren();
  }
  const result = await api(
    `/v1/sessions/${encodeURIComponent(targetSession)}/runs/${encodeURIComponent(targetRunId)}?cursor=${state.transcriptCursor}`,
  );
  if (state.session !== targetSession || state.run?.runId !== targetRunId) return;
  const data = result.data;
  if (!data) return;
  state.run = { ...state.run, status: data.status };
  renderRunState();
  const chunks = data.chunks || [];
  if (chunks.length > 0) $('empty-state')?.remove();
  for (const chunk of chunks) {
    if (chunk.chunkIndex < state.transcriptCursor) continue;
    const box = document.createElement('div');
    box.className = `chunk ${chunk.role === 'prompt' ? 'prompt' : 'output'}`;
    const head = document.createElement('div');
    head.className = 'chunk-head';
    const role = document.createElement('span');
    role.textContent = chunk.role === 'prompt' ? `指令 #${chunk.chunkIndex}` : `输出 #${chunk.chunkIndex}`;
    head.append(role);
    if (chunk.createdAt) {
      const stamp = eventTime(chunk.createdAt);
      const meta = document.createElement('time');
      meta.className = 'chunk-time';
      meta.dateTime = stamp.iso;
      meta.textContent = stamp.relative || stamp.clock;
      meta.title = `${stamp.absolute} · ${stamp.iso}`;
      head.append(meta);
    }
    const body = document.createElement('div');
    body.className = 'chunk-body';
    body.textContent = chunk.text;
    box.append(head, body);
    $('transcript-view').append(box);
    state.transcriptCursor = Math.max(state.transcriptCursor, chunk.chunkIndex + 1);
  }
  if ($('transcript-view').children.length === 0) {
    renderEmptyState('当前会话暂无对话记录');
  }
  $('transcript-view').scrollTop = $('transcript-view').scrollHeight;
  if (typeof data.nextCursor === 'number') {
    state.transcriptCursor = Math.max(state.transcriptCursor, data.nextCursor);
  }
};

const renderSessionGroups = (sessions) => {
  const container = $('session-groups');
  container.replaceChildren();
  const grouped = new Map();
  for (const session of sessions || []) {
    const groupName = session.project || '默认项目 (未分类)';
    if (!grouped.has(groupName)) grouped.set(groupName, []);
    grouped.get(groupName).push(session);
  }
  for (const [groupName, items] of grouped.entries()) {
    const group = document.createElement('div');
    group.className = 'project-group';
    const heading = document.createElement('div');
    heading.className = 'project-title';
    const folder = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    folder.setAttribute('class', 'icon');
    folder.setAttribute('aria-hidden', 'true');
    const folderUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    folderUse.setAttribute('href', '#i-folder');
    folder.append(folderUse);
    const folderLabel = document.createElement('span');
    folderLabel.textContent = `${groupName} (${items.length})`;
    heading.append(folder, folderLabel);
    group.append(heading);
    const list = document.createElement('ul');
    list.className = 'session-list';
    for (const session of items) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = session.sessionId === state.session ? 'active' : '';
      btn.setAttribute('aria-current', session.sessionId === state.session ? 'true' : 'false');
      const nameSpan = document.createElement('span');
      nameSpan.textContent = session.title || session.sessionId;
      const badge = document.createElement('span');
      badge.className = 'session-badge';
      badge.dataset.status = session.status || '';
      badge.textContent = `${session.status} · ${session.runCount ?? 0}`;
      btn.append(nameSpan, badge);
      btn.addEventListener('click', () => selectSession(session.sessionId).catch(showError));
      li.append(btn);
      list.append(li);
    }
    group.append(list);
    container.append(group);
  }
};

const loadSessions = async () => {
  const qs = state.search ? `?q=${encodeURIComponent(state.search)}` : '';
  const result = await api(`/v1/sessions${qs}`);
  state.sessionsCache = result.data || [];
  renderSessionGroups(state.sessionsCache);
  await refreshMetrics();
};

const loadDevices = async () => {
  const result = await api('/v1/devices');
  const list = $('device-list');
  list.replaceChildren();
  for (const device of result.data || []) {
    const li = document.createElement('li');
    li.className = 'device-item';
    const label = document.createElement('span');
    label.textContent = `${device.deviceId} (${device.scopes.join(',')})${device.revokedAt ? ' [已吊销]' : ''}`;
    li.append(label);
    if (!device.revokedAt) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'danger-quiet';
      btn.textContent = '吊销';
      btn.setAttribute('aria-label', `吊销设备 ${device.deviceId}`);
      btn.addEventListener('click', async () => {
        const confirmed = await confirmAction({
          title: '吊销设备',
          message: `吊销后，设备 ${device.deviceId} 将无法继续访问控制面。`,
          confirmLabel: '吊销',
        });
        if (!confirmed) return;
        try {
          await api('/v1/devices/revoke', { method: 'POST', body: JSON.stringify({ deviceId: device.deviceId }) });
          await loadDevices();
        } catch (error) {
          showError(error);
        }
      });
      li.append(btn);
    }
    list.append(li);
  }
};

const stopStream = () => {
  if (state.streamController) {
    state.streamController.abort();
    state.streamController = null;
    $('toggle-stream').textContent = 'SSE 实时';
  }
};

const scheduleTranscriptRefresh = () => {
  if (state.transcriptPending) {
    state.transcriptReloadQueued = true;
    return;
  }
  state.transcriptPending = true;
  void loadTranscript(false)
    .catch(showError)
    .finally(() => {
      state.transcriptPending = false;
      if (state.transcriptReloadQueued) {
        state.transcriptReloadQueued = false;
        scheduleTranscriptRefresh();
      }
    });
};

const REFRESH_STATE_EVENTS = new Set([
  'RunStarted',
  'ApprovalRequested',
  'ApprovalResponded',
  'RunCompleted',
  'RunFailed',
  'RunCancelled',
  'RunUnknown',
  'SessionUpdated',
]);

const startStream = async () => {
  if (!state.session || state.streamController) return;
  const controller = new AbortController();
  state.streamController = controller;
  $('toggle-stream').textContent = '停止 SSE';
  try {
    const headers = {
      accept: 'text/event-stream',
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      ...(state.totp ? { 'x-ccrf-totp': state.totp } : {}),
    };
    const response = await fetch(
      `${state.base}/v1/sessions/${encodeURIComponent(state.session)}/stream?cursor=${state.cursor}`,
      { headers, signal: controller.signal },
    );
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
        if (!dataLine) continue;
        const parsed = JSON.parse(dataLine.slice(6));
        appendEventItem(parsed);
        if (parsed.type === 'OutputChunk') {
          scheduleTranscriptRefresh();
        } else if (REFRESH_STATE_EVENTS.has(parsed.type)) {
          try {
            const detail = await api(`/v1/sessions/${encodeURIComponent(state.session)}`);
            if (detail?.data) renderSession(detail.data);
          } catch {
            // Ignore transient detail fetch failures while streaming.
          }
          scheduleTranscriptRefresh();
          void loadSessions().catch(() => {});
        }
      }
    }
  } catch (error) {
    if (error.name !== 'AbortError') showError(error);
  } finally {
    if (state.streamController === controller) stopStream();
  }
};

const selectSession = async (sessionId) => {
  stopStream();
  showError('');
  showNotice('');
  saveDraft();
  state.session = sessionId;
  state.cursor = 0;
  state.transcriptCursor = 0;
  state.run = null;
  try { localStorage.setItem(LAST_SESSION_KEY, sessionId); } catch {}
  $('events').replaceChildren();
  $('transcript-view').replaceChildren();
  const detail = await api(`/v1/sessions/${encodeURIComponent(sessionId)}`);
  setSessionControlsEnabled(true);
  renderSession(detail.data);
  restoreDraft(sessionId);
  await Promise.all([loadSessions(), refreshEvents(), loadTranscript(true)]);
  if (state.autoStream) {
    void startStream();
  }
};

const generateSessionId = () => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `session-${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
};

const connectAndLoad = async () => {
  saveConnectionProfile();
  await api('/health');
  await Promise.all([loadSessions(), loadDevices()]);
};

const promptInput = $('prompt-input');
promptInput.addEventListener('input', saveDraft);
promptInput.addEventListener('compositionend', (event) => {
  state.lastCompositionEndAt = event.timeStamp;
});
promptInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    if (
      event.isComposing
      || event.keyCode === 229
      || (state.lastCompositionEndAt !== null && Math.abs(event.timeStamp - state.lastCompositionEndAt) < 50)
    ) {
      return;
    }
    if (!$('start-run-btn').disabled) {
      $('run-form').requestSubmit();
    }
  }
});

$('session-search').addEventListener('input', (event) => {
  state.search = event.currentTarget.value.trim();
  loadSessions().catch(showError);
});

$('connect-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');
  showNotice('');
  const form = new FormData(event.currentTarget);
  state.base = String(form.get('base') || location.origin).replace(/\/$/, '');
  state.token = String(form.get('token') || '');
  state.totp = String(form.get('totp') || '').trim();
  try {
    await connectAndLoad();
    state.connectionOpen = false;
    setConnectionUi(true);
    showNotice('已连接控制服务器');
  } catch (error) {
    setConnectionUi(false);
    showError(error);
  }
});

$('pair-login-toggle').addEventListener('click', () => {
  const form = $('pair-login-form');
  form.hidden = !form.hidden;
  $('pair-login-toggle').setAttribute('aria-expanded', String(!form.hidden));
  if (!form.hidden) $('pair-code-input').focus();
});

$('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore storage failures */ }
  applyTheme(next);
});

$('connect-toggle').addEventListener('click', () => {
  state.connectionOpen = $('connect-drawer').hidden;
  const open = state.connectionOpen === true;
  $('connect-drawer').hidden = !open;
  $('connect-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) $('connect-base').focus();
});

$('new-session-toggle').addEventListener('click', () => {
  const form = $('new-session-form');
  const willOpen = form.hidden;
  form.hidden = !willOpen;
  $('new-session-toggle').setAttribute('aria-expanded', String(willOpen));
  if (willOpen) $('session-input').focus();
});

$('copy-run-id').addEventListener('click', async () => {
  const runId = state.run?.runId;
  if (!runId) return;
  try {
    await navigator.clipboard.writeText(runId);
    showNotice('已复制 Run ID');
  } catch {
    showNotice(`Run ID：${runId}`);
  }
});

$('pair-login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');
  showNotice('');
  const base = ($('connect-base').value.trim() || state.base || location.origin).replace(/\/$/, '');
  const code = $('pair-code-input').value.trim();
  if (!code) return;
  try {
    const response = await fetch(`${base}/v1/devices/redeem-pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false || !body.data?.credential) {
      throw new Error(body.error?.message || `HTTP ${response.status}`);
    }
    const issuedCred = body.data.credential;
    state.base = base;
    state.token = issuedCred;
    $('connect-base').value = base === location.origin ? '' : base;
    $('connect-token').value = issuedCred;
    $('pair-code-input').value = '';
    $('pair-login-form').hidden = true;
    $('pair-login-toggle').setAttribute('aria-expanded', 'false');
    await connectAndLoad();
    state.connectionOpen = false;
    setConnectionUi(true);
    showNotice(`已通过6位配对码绑定设备: ${body.data.device?.deviceId || 'device'}`);
  } catch (error) {
    showError(error);
  }
});

$('reload-sessions').addEventListener('click', () => loadSessions().catch(showError));

$('new-session-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');
  showNotice('');
  const rawInput = $('session-input').value.trim();
  const project = $('project-input').value.trim();
  const looksLikeId = /^[A-Za-z0-9._-]+$/.test(rawInput);
  const sessionId = rawInput && looksLikeId ? rawInput : generateSessionId();
  const title = rawInput && !looksLikeId ? rawInput : (rawInput || `对话 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);
  try {
    try {
      await api('/v1/sessions/create', {
        method: 'POST',
        body: JSON.stringify({
          sessionId,
          title,
          ...(project ? { project } : {}),
          approvalMode: $('approval-mode').value,
          reasoningEffort: $('reasoning-effort').value,
          ...($('account-profile').value ? { accountProfile: $('account-profile').value } : {}),
        }),
      });
    } catch (error) {
      if (!String(error.message).includes('conflicts')) throw error;
    }
    saveConnectionProfile();
    $('session-input').value = '';
    $('new-session-form').hidden = true;
    $('new-session-toggle').setAttribute('aria-expanded', 'false');
    await selectSession(sessionId);
  } catch (error) {
    showError(error);
  }
});

$('rename-toggle').addEventListener('click', () => {
  $('rename-bar').hidden = !$('rename-bar').hidden;
});

$('rename-cancel').addEventListener('click', () => {
  $('rename-bar').hidden = true;
});

$('rename-bar').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.session) return;
  try {
    await api(`/v1/sessions/${encodeURIComponent(state.session)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title: $('rename-title-input').value.trim(),
        project: $('rename-project-input').value.trim(),
      }),
    });
    $('rename-bar').hidden = true;
    await selectSession(state.session);
  } catch (error) {
    showError(error);
  }
});

for (const id of ['approval-mode', 'reasoning-effort', 'account-profile']) {
  $(id).addEventListener('change', async () => {
    if (!state.session) return;
    try {
      await api(`/v1/sessions/${encodeURIComponent(state.session)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          approvalMode: $('approval-mode').value,
          reasoningEffort: $('reasoning-effort').value,
          accountProfile: $('account-profile').value,
        }),
      });
      await selectSession(state.session);
    } catch (error) {
      showError(error);
    }
  });
}

$('fork-session').addEventListener('click', async () => {
  if (!state.session) return;
  showError('');
  const newSessionId = `${state.session}-fork-${Date.now().toString(36)}`.slice(0, 180);
  try {
    await api(`/v1/sessions/${encodeURIComponent(state.session)}/fork`, {
      method: 'POST',
      body: JSON.stringify({ newSessionId }),
    });
    await selectSession(newSessionId);
    showNotice(`已从 ${state.session} 分叉出 ${newSessionId}`);
  } catch (error) {
    showError(error);
  }
});

$('export-session').addEventListener('click', async () => {
  if (!state.session) return;
  showError('');
  try {
    const res = await api(`/v1/sessions/${encodeURIComponent(state.session)}/export?format=markdown`);
    const markdown = res.data?.markdown || JSON.stringify(res.data, null, 2);
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${state.session}.md`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showNotice(`已导出 ${state.session}.md`);
  } catch (error) {
    showError(error);
  }
});

$('delete-session').addEventListener('click', async () => {
  if (!state.session) return;
  const label = $('active-session').textContent || state.session;
  const confirmed = await confirmAction({
    title: '删除会话',
    message: `将永久删除「${label}」及其运行记录。此操作无法撤销。`,
    confirmLabel: '删除会话',
  });
  if (!confirmed) return;
  try {
    stopStream();
    await api(`/v1/sessions/${encodeURIComponent(state.session)}`, { method: 'DELETE' });
    try { localStorage.removeItem(draftKey(state.session)); } catch {}
    state.session = '';
    state.run = null;
    setSessionControlsEnabled(false);
    $('active-session').textContent = '未选择';
    $('active-session').removeAttribute('title');
    $('active-project-tag').textContent = '';
    $('active-project-tag').hidden = true;
    $('active-claude-tag').textContent = '';
    $('active-claude-tag').hidden = true;
    $('session-status').textContent = '未选择';
    $('session-status').dataset.status = '';
    $('generation').textContent = '-';
    $('prompt-input').value = '';
    $('events').replaceChildren();
    renderEmptyState();
    renderRunState();
    await loadSessions();
  } catch (error) {
    showError(error);
  }
});

$('compact-sessions').addEventListener('click', async () => {
  try {
    const res = await api('/v1/sessions/compact', { method: 'POST', body: JSON.stringify({ keepLatestRunsPerSession: 5 }) });
    showNotice(`历史压缩完成，清理分片 ${res.data?.prunedChunks ?? 0} 条`);
  } catch (error) {
    showError(error);
  }
});

$('enroll-device-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');
  const form = new FormData(event.currentTarget);
  const deviceId = String(form.get('deviceId') || '').trim();
  const label = String(form.get('label') || '').trim();
  const scopes = String(form.get('scopes') || '').split(',').map((s) => s.trim()).filter(Boolean);
  try {
    const res = await api('/v1/devices/enroll', {
      method: 'POST',
      body: JSON.stringify({ deviceId, label, scopes }),
    });
    const box = $('enrolled-credential');
    box.hidden = false;
    box.textContent = `设备 ${deviceId} 凭据: ${res.data.credential}`;
    await loadDevices();
  } catch (error) {
    showError(error);
  }
});

$('pair-code-btn').addEventListener('click', async () => {
  showError('');
  const form = new FormData($('enroll-device-form'));
  const deviceId = String(form.get('deviceId') || '').trim() || `dev-${Date.now().toString(36)}`;
  const label = String(form.get('label') || '').trim() || 'Mobile / CLI';
  const scopes = String(form.get('scopes') || 'control,read').split(',').map((s) => s.trim()).filter(Boolean);
  try {
    const res = await api('/v1/devices/pair-code', {
      method: 'POST',
      body: JSON.stringify({ deviceId, label, scopes }),
    });
    const box = $('enrolled-credential');
    box.hidden = false;
    box.textContent = `6位配对码 (${deviceId}): ${res.data.code}（5分钟内单次有效）`;
  } catch (error) {
    showError(error);
  }
});

const submitPrompt = async (promptText) => {
  showError('');
  showNotice('');
  state.lastPrompt = promptText;
  $('retry-last').hidden = true;
  const execute = $('run-form').elements.execute.checked;
  const approvalMode = $('approval-mode').value;
  const reasoningEffort = $('reasoning-effort').value;
  try {
    const result = await api(`/v1/sessions/${encodeURIComponent(state.session)}/runs`, {
      method: 'POST',
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        generation: state.generation,
        idempotencyKey: crypto.randomUUID(),
        prompt: promptText,
        execute,
        ...(execute ? { async: true } : {}),
        approvalMode,
        reasoningEffort,
      }),
    });
    state.run = result.data;
    state.transcriptCursor = 0;
    $('prompt-input').value = '';
    saveDraft();
    renderRunState();
    await loadTranscript(true);
    if (state.autoStream && !state.streamController) {
      void startStream();
    }
    if (!execute) {
      await Promise.all([refreshEvents(), loadSessions()]);
    }
  } catch (error) {
    $('retry-last').hidden = false;
    showError(error);
  }
};

$('run-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const prompt = $('prompt-input').value;
  if (!prompt.trim()) return;
  await submitPrompt(prompt);
});

$('retry-last').addEventListener('click', async () => {
  if (!state.lastPrompt || !state.session) return;
  await submitPrompt(state.lastPrompt);
});

$('load-transcript').addEventListener('click', () => loadTranscript(false).catch(showError));

$('cancel').addEventListener('click', async () => {
  if (!state.run?.leaseId) return;
  const confirmed = await confirmAction({
    title: '取消运行',
    message: '将中止当前运行。已经产生的输出会保留。',
    confirmLabel: '取消运行',
    dismissLabel: '继续运行',
  });
  if (!confirmed) return;
  try {
    const res = await api(`/v1/sessions/${encodeURIComponent(state.session)}/runs/cancel`, {
      method: 'POST',
      body: JSON.stringify({ runId: state.run.runId, leaseId: state.run.leaseId }),
    });
    state.run = res.data;
    renderRunState();
    await refreshEvents();
  } catch (error) {
    showError(error);
  }
});

for (const [id, approved] of [['approve-yes', true], ['approve-no', false]]) {
  $(id).addEventListener('click', async () => {
    if (!state.run?.leaseId) return;
    try {
      const res = await api(`/v1/sessions/${encodeURIComponent(state.session)}/runs/approve`, {
        method: 'POST',
        body: JSON.stringify({ runId: state.run.runId, leaseId: state.run.leaseId, approved }),
      });
      state.run = res.data;
      renderRunState();
      await refreshEvents();
    } catch (error) {
      showError(error);
    }
  });
}

for (const [id, action] of [['disconnect', 'disconnect'], ['reconnect', 'reconnect']]) {
  $(id).addEventListener('click', async () => {
    try {
      const res = await api(`/v1/sessions/${encodeURIComponent(state.session)}/${action}`, { method: 'POST' });
      renderSession(res.data);
      await Promise.all([refreshEvents(), loadSessions()]);
    } catch (error) {
      showError(error);
    }
  });
}

$('refresh').addEventListener('click', () => Promise.all([refreshEvents(), loadTranscript(false)]).catch(showError));

$('toggle-stream').addEventListener('click', () => {
  if (state.streamController) {
    state.autoStream = false;
    stopStream();
    return;
  }
  state.autoStream = true;
  void startStream();
});

window.addEventListener('DOMContentLoaded', async () => {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
    if (typeof saved.base === 'string') {
      state.base = saved.base;
      $('connect-base').value = saved.base;
    } else if (location.origin && location.origin !== 'null') {
      state.base = location.origin;
    }
    if (typeof saved.lastProject === 'string') {
      $('project-input').value = saved.lastProject;
    }
    await connectAndLoad();
    state.connectionOpen = false;
    setConnectionUi(true);
    const lastSession = localStorage.getItem(LAST_SESSION_KEY);
    if (lastSession && state.sessionsCache.some((s) => s.sessionId === lastSession)) {
      await selectSession(lastSession);
    }
  } catch {
    setConnectionUi(false);
  }
});
