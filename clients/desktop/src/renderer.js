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

const DRAFT_PREFIX = 'ccrf:draft:';
const LAST_SESSION_KEY = 'ccrf:last-session';

const state = {
  session: '',
  generation: 0,
  run: null,
  transcriptCursor: 0,
  lastEventSeq: 0,
  transcriptPending: false,
  transcriptReloadQueued: false,
  search: '',
  sessionsCache: [],
  lastPrompt: '',
  localServerRunning: false,
  localRunnerRunning: false,
  lastCompositionEndAt: null,
  connected: false,
};

const showError = (error) => {
  const text = error instanceof Error ? error.message : String(error || '');
  $('error').textContent = text;
  const connectionProblem = !state.connected || /401|403|Failed to fetch|NetworkError|ECONN/.test(text);
  if (text && connectionProblem && $('connect-drawer')) $('connect-drawer').open = true;
};

const showNotice = (message) => {
  $('notice').textContent = message || '';
};

const TIME_LOCALE = 'zh-CN';
const absoluteFormat = new Intl.DateTimeFormat(TIME_LOCALE, {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const relativeFormat = new Intl.RelativeTimeFormat(TIME_LOCALE, { numeric: 'auto' });
const TERMINAL_RUN = new Set(['completed', 'failed', 'cancelled', 'unknown']);

const eventTime = (iso) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return { relative: '', absolute: String(iso || ''), iso: String(iso || '') };
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
  return { relative, absolute: absoluteFormat.format(date), iso: date.toISOString() };
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
  const status = $('connection-status');
  if (!status) return;
  status.dataset.state = connected ? 'online' : 'offline';
  status.textContent = connected ? '已连接' : '未连接';
  if (connected && $('connect-drawer')) $('connect-drawer').open = false;
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

const renderEmptyState = (title = '欢迎使用 BastionCC（棱堡）桌面工作台') => {
  const box = document.createElement('div');
  box.id = 'empty-state';
  box.className = 'empty-guide';
  const heading = document.createElement('h3');
  heading.textContent = title;
  const list = document.createElement('ol');
  for (const step of [
    '点击上方「一键本地服务」快速体验，或展开「连接设置」连入服务器。',
    '左侧点击「新建」，选择项目目录并创建会话（自动保留服务器原生 claude --resume 上下文）。',
    '在下方输入指令，按 Enter 发送（支持中文输入法防误触），Shift + Enter 换行。',
  ]) {
    const li = document.createElement('li');
    li.textContent = step;
    list.append(li);
  }
  box.append(heading, list);
  $('transcript').replaceChildren(box);
};

const renderDesktopRuntime = (runtime) => {
  if (!runtime) return;
  state.localServerRunning = Boolean(runtime.localServer?.running);
  state.localRunnerRunning = Boolean(runtime.localRunner?.running);
  const serverBtn = $('toggle-local-server');
  serverBtn.querySelector('.btn-label').textContent = state.localServerRunning ? '本地服务运行中' : '一键本地服务';
  serverBtn.className = state.localServerRunning ? 'active-toggle compact' : 'secondary compact';
  const runnerBtn = $('toggle-local-runner');
  runnerBtn.querySelector('.btn-label').textContent = state.localRunnerRunning ? '本机执行器运行中' : '本机执行器';
  runnerBtn.className = state.localRunnerRunning ? 'active-toggle compact' : 'secondary compact';
  if (runtime.config?.baseUrl) $('base-url-input').value = runtime.config.baseUrl;
  if (runtime.config?.authToken) $('auth-token-input').value = runtime.config.authToken;
  if (runtime.config?.lastProject && !$('project-input').value) $('project-input').value = runtime.config.lastProject;
};

const refreshMetrics = async () => {
  try {
    const metrics = await window.relay.getMetrics();
    if (!metrics) return;
    $('metrics-pill').textContent = `会话 ${metrics.totalSessions} · 轮次 ${metrics.totalRuns} · ~${metrics.estimatedTokens} Tokens · 缓存命中 ${metrics.cacheHitRate ?? 0}%`;
  } catch {
    // Ignore metrics polling failures before connection.
  }
};

const renderRunState = () => {
  const awaiting = Boolean(state.run?.leaseId && state.run.status === 'awaiting_approval');
  $('approval-banner').hidden = !awaiting;
  $('approve-yes').disabled = !awaiting;
  $('approve-no').disabled = !awaiting;
  const run = state.run;
  const runEl = $('run-id');
  const copyBtn = $('copy-run-id');
  const runStatus = $('run-status');
  if (runEl) {
    if (!run) {
      runEl.textContent = '无';
      runEl.removeAttribute('title');
      if (copyBtn) copyBtn.hidden = true;
      if (runStatus) {
        runStatus.hidden = true;
        runStatus.textContent = '';
        runStatus.dataset.status = '';
      }
    } else {
      runEl.textContent = shortId(run.runId);
      runEl.title = run.runId;
      if (copyBtn) copyBtn.hidden = false;
      if (runStatus) {
        runStatus.hidden = false;
        runStatus.textContent = run.status || '';
        runStatus.dataset.status = run.status || '';
      }
    }
  }
  const cancel = $('cancel');
  const cancellable = Boolean(run?.leaseId) && !TERMINAL_RUN.has(run.status);
  cancel.hidden = !cancellable;
  cancel.disabled = !cancellable;
  cancel.classList.toggle('danger', cancellable);
  cancel.classList.toggle('secondary', !cancellable);
};

const setSessionEnabled = (enabled) => {
  for (const id of ['delete-session', 'disconnect', 'reconnect', 'start-run', 'rename-toggle', 'fork-session', 'export-session']) {
    $(id).disabled = !enabled;
  }
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
    $('transcript').replaceChildren();
  }
  const page = await window.relay.getRunTranscript(targetSession, targetRunId, state.transcriptCursor);
  if (state.session !== targetSession || state.run?.runId !== targetRunId) return;
  if (!page) return;
  state.run = { ...state.run, status: page.status };
  renderRunState();
  const chunks = page.chunks || [];
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
      meta.textContent = stamp.relative;
      meta.title = `${stamp.absolute} · ${stamp.iso}`;
      head.append(meta);
    }
    const body = document.createElement('div');
    body.className = 'chunk-body';
    body.textContent = chunk.text;
    box.append(head, body);
    $('transcript').append(box);
    state.transcriptCursor = Math.max(state.transcriptCursor, chunk.chunkIndex + 1);
  }
  if ($('transcript').children.length === 0) {
    renderEmptyState('当前会话暂无对话记录');
  }
  $('transcript').scrollTop = $('transcript').scrollHeight;
  if (typeof page.nextCursor === 'number') state.transcriptCursor = Math.max(state.transcriptCursor, page.nextCursor);
};

const renderSessionGroups = (sessions) => {
  const container = $('session-groups');
  container.replaceChildren();
  const grouped = new Map();
  for (const item of sessions || []) {
    const groupName = item.project || '默认项目 (未分类)';
    if (!grouped.has(groupName)) grouped.set(groupName, []);
    grouped.get(groupName).push(item);
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
    for (const item of items) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = item.sessionId === state.session ? 'session-btn selected' : 'session-btn';
      btn.setAttribute('aria-current', item.sessionId === state.session ? 'true' : 'false');
      const label = document.createElement('span');
      label.textContent = item.title || item.sessionId;
      const badge = document.createElement('span');
      badge.className = 'session-badge';
      badge.dataset.status = item.status || '';
      badge.textContent = `${item.status} · ${item.runCount ?? 0}`;
      btn.append(label, badge);
      btn.addEventListener('click', () => selectSession(item.sessionId).catch(showError));
      li.append(btn);
      list.append(li);
    }
    group.append(list);
    container.append(group);
  }
};

const loadSessions = async () => {
  const filter = state.search ? { query: state.search } : undefined;
  const sessions = await window.relay.listSessions(filter);
  state.sessionsCache = sessions || [];
  renderSessionGroups(state.sessionsCache);
  await refreshMetrics();
};

const updateTagChip = (id, text) => {
  const el = $(id);
  if (!text) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = text;
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

const renderSessionHeader = (session, previousRun) => {
  const name = $('active-session');
  name.textContent = session.title || session.sessionId;
  name.title = session.title && session.title !== session.sessionId
    ? `${session.title} · ${session.sessionId}`
    : session.sessionId;
  updateTagChip('active-project-tag', session.project || '');
  updateTagChip('active-claude-tag', [
    session.accountProfile || '',
    session.providerSessionId ? `Claude 续接 ${session.providerSessionId.slice(0, 8)}` : '',
  ].filter(Boolean).join(' · '));
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
      status: session.currentRunStatus || (previousRun?.runId === session.currentRunId ? previousRun.status : 'unknown'),
      ...(previousRun?.runId === session.currentRunId && previousRun.leaseId ? { leaseId: previousRun.leaseId } : {}),
    };
  }
};

const selectSession = async (sessionId) => {
  showError('');
  showNotice('');
  saveDraft();
  const previousRun = state.run;
  state.session = sessionId;
  state.run = null;
  state.transcriptCursor = 0;
  state.lastEventSeq = 0;
  try {
    localStorage.setItem(LAST_SESSION_KEY, sessionId);
  } catch {
    // Ignore storage failures.
  }
  const session = await window.relay.getSession(sessionId);
  renderSessionHeader(session, previousRun);
  setSessionEnabled(true);
  restoreDraft(sessionId);
  renderRunState();
  await Promise.all([loadSessions(), loadTranscript(true)]);
  await window.relay.subscribeSession(sessionId, 0);
};

const generateSessionId = () => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `session-${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
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
    if (!$('start-run').disabled) {
      $('run-form').requestSubmit();
    }
  }
});

$('session-search').addEventListener('input', (event) => {
  state.search = event.currentTarget.value.trim();
  loadSessions().catch(showError);
});

$('pick-folder').addEventListener('click', async () => {
  try {
    const picked = await window.relay.pickFolder();
    if (!picked.canceled && picked.path) {
      $('project-input').value = picked.path;
    }
  } catch (error) {
    showError(error);
  }
});

$('toggle-local-server').addEventListener('click', async () => {
  showError('');
  showNotice('');
  try {
    const runtime = await window.relay.toggleLocalServer();
    renderDesktopRuntime(runtime);
    if (runtime.localServer?.running) {
      await loadSessions();
      setConnectionUi(true);
      showNotice(`本地服务已就绪: ${runtime.localServer.baseUrl}`);
    } else {
      showNotice('本地服务已停止');
    }
  } catch (error) {
    showError(error);
  }
});

$('toggle-local-runner').addEventListener('click', async () => {
  showError('');
  try {
    const runtime = await window.relay.toggleLocalRunner();
    renderDesktopRuntime(runtime);
    showNotice(runtime.localRunner?.running ? '本机执行器已启动，等待队列任务' : '本机执行器已停止');
  } catch (error) {
    showError(error);
  }
});

$('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore storage failures */ }
  applyTheme(next);
});

$('connect-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');
  const form = new FormData(event.currentTarget);
  try {
    await window.relay.configure({
      baseUrl: String(form.get('baseUrl') || 'http://127.0.0.1:8787'),
      authToken: String(form.get('authToken') || ''),
      totp: String(form.get('totp') || '').trim() || undefined,
    });
    await loadSessions();
    setConnectionUi(true);
    showNotice('已连接到控制服务器');
  } catch (error) {
    setConnectionUi(false);
    showError(error);
  }
});

$('pair-login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');
  showNotice('');
  const baseUrl = String($('base-url-input').value || 'http://127.0.0.1:8787').trim();
  const code = String($('pair-code-input').value || '').trim();
  if (!code) return;
  try {
    await window.relay.configure({ baseUrl, authToken: '' });
    const redeemed = await window.relay.redeemPairingCode(code);
    await window.relay.configure({ baseUrl, authToken: redeemed.credential });
    $('auth-token-input').value = redeemed.credential;
    $('pair-code-input').value = '';
    await loadSessions();
    setConnectionUi(true);
    showNotice(`已通过6位配对码绑定设备: ${redeemed.device?.deviceId || 'device'}`);
  } catch (error) {
    showError(error);
  }
});

$('oauth-login').addEventListener('click', () => {
  window.relay.openExternal('https://claude.ai/login').catch(showError);
});

$('pair-code-btn').addEventListener('click', async () => {
  showError('');
  try {
    const challenge = await window.relay.createPairingCode({
      deviceId: `dev-${Date.now().toString(36)}`,
      label: 'Remote CLI / Mobile',
      scopes: ['control', 'read'],
    });
    showNotice(`一次性6位配对码（5分钟内有效，仅限单次兑换）: ${challenge.code}`);
  } catch (error) {
    showError(error);
  }
});

$('reload-sessions').addEventListener('click', () => loadSessions().catch(showError));

$('create-session-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');
  const rawInput = $('new-session-input').value.trim();
  const project = $('project-input').value.trim();
  const looksLikeId = /^[A-Za-z0-9._-]+$/.test(rawInput);
  const sessionId = rawInput && looksLikeId ? rawInput : generateSessionId();
  const title = rawInput && !looksLikeId ? rawInput : (rawInput || `对话 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);
  try {
    await window.relay.createSession(sessionId, {
      title,
      ...(project ? { project } : {}),
      approvalMode: $('approval-mode').value,
      reasoningEffort: $('reasoning-effort').value,
      ...($('account-profile').value ? { accountProfile: $('account-profile').value } : {}),
    });
    if (project) await window.relay.saveConfig({ lastProject: project });
    $('new-session-input').value = '';
    $('create-session-form').hidden = true;
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
    await window.relay.updateSession(state.session, {
      title: $('rename-title-input').value.trim(),
      project: $('rename-project-input').value.trim(),
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
      await window.relay.updateSession(state.session, {
        approvalMode: $('approval-mode').value,
        reasoningEffort: $('reasoning-effort').value,
        accountProfile: $('account-profile').value,
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
    await window.relay.forkSession(state.session, { newSessionId });
    await selectSession(newSessionId);
    showNotice(`已从 ${state.session} 分叉出新会话 ${newSessionId}`);
  } catch (error) {
    showError(error);
  }
});

$('export-session').addEventListener('click', async () => {
  if (!state.session) return;
  showError('');
  try {
    const exported = await window.relay.exportSession(state.session, 'markdown');
    const blob = new Blob([exported.markdown || JSON.stringify(exported, null, 2)], { type: 'text/markdown;charset=utf-8' });
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

$('new-session-toggle').addEventListener('click', () => {
  const form = $('create-session-form');
  const willOpen = form.hidden;
  form.hidden = !willOpen;
  $('new-session-toggle').setAttribute('aria-expanded', String(willOpen));
  if (willOpen) $('new-session-input').focus();
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
    await window.relay.unsubscribeSession();
    await window.relay.deleteSession(state.session);
    try { localStorage.removeItem(draftKey(state.session)); } catch {}
    state.session = '';
    state.run = null;
    setSessionEnabled(false);
    $('active-session').textContent = '未选择会话';
    $('active-session').removeAttribute('title');
    updateTagChip('active-project-tag', '');
    updateTagChip('active-claude-tag', '');
    $('session-status').textContent = '未选择';
    $('session-status').dataset.status = '';
    $('generation').textContent = '-';
    $('prompt-input').value = '';
    renderEmptyState();
    renderRunState();
    await loadSessions();
  } catch (error) {
    showError(error);
  }
});

$('compact-sessions').addEventListener('click', async () => {
  try {
    const res = await window.relay.compactSessions(5);
    showNotice(`历史压缩完成，清理分片 ${res?.prunedChunks ?? 0} 条`);
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
    state.run = await window.relay.startRun(state.session, {
      requestId: crypto.randomUUID(),
      generation: state.generation,
      idempotencyKey: crypto.randomUUID(),
      prompt: promptText,
      execute,
      ...(execute ? { async: true } : {}),
      approvalMode,
      reasoningEffort,
    });
    state.transcriptCursor = 0;
    $('prompt-input').value = '';
    saveDraft();
    renderRunState();
    await loadTranscript(true);
    await window.relay.subscribeSession(state.session, state.lastEventSeq);
    if (!execute) {
      await loadSessions();
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
    state.run = await window.relay.cancelRun(state.session, { runId: state.run.runId, leaseId: state.run.leaseId });
    renderRunState();
  } catch (error) {
    showError(error);
  }
});

for (const [id, approved] of [['approve-yes', true], ['approve-no', false]]) {
  $(id).addEventListener('click', async () => {
    if (!state.run?.leaseId) return;
    try {
      state.run = await window.relay.respondApproval(state.session, { runId: state.run.runId, leaseId: state.run.leaseId, approved });
      renderRunState();
    } catch (error) {
      showError(error);
    }
  });
}

for (const [id, fn] of [['disconnect', 'disconnect'], ['reconnect', 'reconnect']]) {
  $(id).addEventListener('click', async () => {
    try {
      const updated = await window.relay[fn](state.session);
      $('session-status').textContent = updated.status;
      $('session-status').dataset.status = updated.status || '';
      $('generation').textContent = String(updated.generation);
      state.generation = updated.generation;
    } catch (error) {
      showError(error);
    }
  });
}

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

window.relay.onSessionEvent((event) => {
  if (!event || event.aggregateId !== state.session) return;
  if (typeof event.sequence === 'number') {
    state.lastEventSeq = Math.max(state.lastEventSeq, event.sequence);
  }
  if (event.type === 'OutputChunk') {
    scheduleTranscriptRefresh();
  } else if (REFRESH_STATE_EVENTS.has(event.type)) {
    void (async () => {
      try {
        const previousRun = state.run;
        const session = await window.relay.getSession(state.session);
        renderSessionHeader(session, previousRun);
        renderRunState();
      } catch {
        // Ignore transient fetch errors while streaming.
      }
      scheduleTranscriptRefresh();
      await loadSessions().catch(() => {});
    })();
  }
});

window.addEventListener('DOMContentLoaded', async () => {
  try {
    const runtime = await window.relay.getDesktopState();
    renderDesktopRuntime(runtime);
    await loadSessions();
    setConnectionUi(true);
    const lastSession = localStorage.getItem(LAST_SESSION_KEY);
    if (lastSession && state.sessionsCache.some((s) => s.sessionId === lastSession)) {
      await selectSession(lastSession);
    }
  } catch {
    setConnectionUi(false);
    if ($('connect-drawer')) $('connect-drawer').open = true;
  }
});
