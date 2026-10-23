export const SIDE_CHAT_KIND = 'sidechat';
export const SIDE_CHAT_ADDRESS = 'dsh-resource://sidechat/session/';
export const SIDE_CHAT_BODY_SLOT = 'dsh-plugin-side-chat-native.body';
export const SIDE_CHAT_ID = 'dsh-plugin-side-chat-native';
export function chatAddress(id) { return SIDE_CHAT_ADDRESS + encodeURIComponent(id); }
export function parseChatAddress(value) {
  if (typeof value !== 'string' || !value.startsWith(SIDE_CHAT_ADDRESS)) return undefined;
  try {
    const id = decodeURIComponent(value.slice(SIDE_CHAT_ADDRESS.length));
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id) || id.includes('..')) return undefined;
    if (chatAddress(id) !== value) return undefined;
    return { sessionId: id };
  } catch { return undefined; }
}
function waitForAbort(signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
}

/** Private capability storage: no tokens in addresses, DOM, localStorage or logs. */
export function createSideChatClient(connection, makeId = () => `native-open-${globalThis.crypto.randomUUID()}`) {
  const pages = new Map(), owned = new Map(), listeners = new Set();
  const promotions = new Map(), recoveries = new Map();
  const notify = () => { for (const listener of listeners) listener(); };
  const has = id => owned.has(id) && owned.get(id).status !== 'unowned';
  function record(value) {
    return { token: value.promoted ? undefined : value.token, status: value.promoted ? 'promoted' : 'open', error: '', context: value.context };
  }
  function reportError(id, error) {
    if (!owned.has(id)) owned.set(id, { status: 'unowned' });
    owned.get(id).error = error?.message ?? String(error); notify();
  }
  async function call(method, payload) {
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 90000);
    try {
      const result = await connection.rpc.call('/api', `sideChatNative.${method}`, payload, abort.signal);
      if (result?.ok !== true) throw Object.assign(new Error(result?.error?.message ?? '侧聊服务返回无效响应'), { code: result?.error?.code });
      return result.value;
    } finally { clearTimeout(timeout); }
  }
  function open(pageId, sourceSessionId) {
    let page = pages.get(pageId);
    if (!page) { page = { requestId: makeId(), sourceSessionId }; pages.set(pageId, page); }
    if (page.sourceSessionId !== sourceSessionId) return Promise.reject(new Error('侧聊来源会话已改变'));
    if (page.value) return Promise.resolve(page.value);
    if (page.promise) return page.promise;
    page.promise = call('open', { sourceSessionId, requestId: page.requestId }).then(value => {
      if (typeof value?.sessionId !== 'string' || typeof value?.token !== 'string' || value.closed) throw new Error('侧聊已关闭，或宿主返回了无效句柄');
      // A delayed/replayed open must not overwrite a completed promotion.
      if (!has(value.sessionId) || value.promoted) owned.set(value.sessionId, record(value));
      page.value = { sessionId: value.sessionId, context: value.context };
      notify(); return page.value;
    }).finally(() => { page.promise = undefined; });
    return page.promise;
  }
  function close(sessionId) {
    if (promotions.has(sessionId)) return Promise.reject(new Error('正在转为主会话，不能同时清理'));
    const entry = owned.get(sessionId);
    if (!has(sessionId)) return Promise.reject(new Error('这是重启前或其他来源的会话，只释放视图，不允许自动删除'));
    if (entry.status === 'closed' || entry.status === 'promoted') return Promise.resolve();
    if (entry.promise) return entry.promise;
    entry.status = 'closing'; entry.error = ''; notify();
    entry.promise = call('close', { sessionId, token: entry.token }).then(value => {
      // Another Client may already have promoted this Session. The Host must
      // protect it; this occurrence can close, but its history is NOT removed.
      entry.status = value?.promoted ? 'promoted' : 'closed'; entry.token = undefined;
    }, error => {
      entry.status = 'open'; entry.error = error.message; throw error;
    }).finally(() => { entry.promise = undefined; notify(); });
    return entry.promise;
  }
  function recover(sessionId, sourceSessionId) {
    if (has(sessionId)) return Promise.resolve();
    if (recoveries.has(sessionId)) return recoveries.get(sessionId);
    const task = call('recover', { sessionId, sourceSessionId }).then(value => {
      if (value?.sessionId !== sessionId || !value.token || value.closed) throw new Error('侧聊所有权已失效，保留记录，不自动删除');
      // Never let an older recovery overwrite a newer promoted/closing state.
      if (!has(sessionId)) { owned.set(sessionId, record(value)); notify(); }
    }).finally(() => { recoveries.delete(sessionId); });
    recoveries.set(sessionId, task); return task;
  }
  function promote(sessionId, sourceSessionId) {
    if (promotions.has(sessionId)) return promotions.get(sessionId);
    // Re-ack even an already protected Session: a failed/default workspace
    // attachment must be retryable after recovery or a lost response.
    if (['closing', 'closed'].includes(owned.get(sessionId)?.status)) return Promise.reject(new Error('侧聊已关闭或正在清理，不能转为主会话'));
    const task = (async () => {
      if (!has(sessionId)) {
        try { await recover(sessionId, sourceSessionId); }
        catch (error) { if (error.code !== 'sidechat/not-owned') throw error; }
      }
      const entry = owned.get(sessionId);
      const value = await call('promote', { sessionId, sourceSessionId, ...(entry?.token ? { token: entry.token } : {}) });
      if (value?.sessionId !== sessionId || value.promoted !== true) throw new Error('宿主尚未确认保留会话，未切换主聊天');
      owned.set(sessionId, { ...entry, status: 'promoted', token: undefined, error: '' });
      for (const [pageId, page] of pages) if (page.value?.sessionId === sessionId) pages.delete(pageId);
      return { sessionId, promoted: true };
    })().catch(error => { reportError(sessionId, error); throw error; })
      .finally(() => { promotions.delete(sessionId); notify(); });
    promotions.set(sessionId, task); notify(); return task;
  }
  return { open, recover, promote, close, has, reportError,
    state: id => promotions.has(id) ? 'promoting' : owned.get(id)?.status,
    error: id => owned.get(id)?.error ?? '', subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
}

/** Native reference owner: cancellation releases a VIEW, never erases a Session. */
export function resourceProvider(sessions) {
  return { protocol: 'sidechat', async *open(address, { signal }) {
    const parsed = parseChatAddress(address);
    if (!parsed) throw new Error('无效的侧聊资源地址');
    if (signal.aborted) return;
    const reference = sessions.retain(parsed.sessionId, { source: 'sidebarChat', signal });
    try {
      await reference.ready;
      if (signal.aborted) return;
      yield { ok: true, value: { reference, address: parsed } };
      await waitForAbort(signal);
    } finally { reference.release(); }
  } };
}

export function installNativeSideChat(ctx, { React, client, MenuItemButton = 'button' }) {
  const h = React.createElement, pageTasks = new Map(), tabClosers = new Map(), transfers = new Map();
  const occurrenceKey = (sessionId, tabId) => JSON.stringify([sessionId, tabId]);
  function SideChatGuideIcon({ size = 36, className }) {
    // Match native guide artwork's 36-unit canvas, optical inset and blue ink.
    // The native 26/22px icon seat owns alignment; do not shift the card itself.
    return h('svg', { width: size, height: size, viewBox: '0 0 36 36', fill: 'none',
      stroke: '#539CFA', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      className, 'aria-hidden': 'true', focusable: 'false' },
      h('path', { d: 'M11 8h11a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-8l-6 5V11a3 3 0 0 1 3-3Z' }),
      h('path', { d: 'M25 13h1a3 3 0 0 1 3 3v12l-5-4h-8' }),
      h('path', { d: 'M13 15h7' }));
  }
  function PromoteMenuItem(props) {
    const parsed = props.tab.kind === SIDE_CHAT_KIND && parseChatAddress(props.tab.contentId);
    const [, refresh] = React.useState(0);
    React.useEffect(() => client.subscribe(() => refresh(value => value + 1)), []);
    if (!parsed) return null;
    const id = parsed.sessionId, phase = client.state(id);
    function select() {
      if (transfers.has(id) || ['closing', 'closed', 'promoting'].includes(client.state(id))) return;
      let closeView;
      try {
        if (typeof ctx.uiWorkspace?.openSession !== 'function') throw new Error('主会话导航不可用，请正常重启 DSH 加载新版插件');
        // List-menu children receive tab/dismiss, NOT their parent's injected
        // occurrence(). Use the action bound by this exact mounted side view.
        const held = tabClosers.get(occurrenceKey(props.sessionId, props.tab.id));
        if (!held || held.signal.aborted) throw new Error('侧聊标签尚未就绪或已关闭，未切换主会话');
        // Capture before await/navigation can unmount the original sidebar.
        closeView = held.close;
      } catch (error) { client.reportError(id, error); return; }
      props.dismiss();
      const task = client.promote(id, props.sessionId).then(() => {
        if (ctx.sidebarRight.commandTarget(null)?.sessionId !== props.sessionId) throw new Error('主会话已切换；聊天记录已保留，请回原标签重试打开');
        // Native openSession retains the same ID as main before releasing the
        // old main reference. No copy, new Agent, cancel, archive or delete.
        ctx.uiWorkspace.openSession(id);
        closeView();
      }).catch(error => client.reportError(id, error)).finally(() => { transfers.delete(id); });
      transfers.set(id, task);
    }
    return h(MenuItemButton, { disabled: ['closing', 'closed', 'promoting'].includes(phase), onSelect: select },
      phase === 'promoting' ? '正在转为主会话…' : '转为主会话');
  }
  function FixedChatConversationView(props) {
    return props.renderSlot('conversation.session', { view: 'chat' });
  }
  function ConversationPanel({ useSession, useConversation, useSessions, sessionId, renderFactorySlot }) {
    const session = useSession(value => value);
    const conversation = useConversation(value => value);
    const active = conversation.activeTargets.size > 0 || !session.blank && !session.awaitingFirstTurn || session.running;
    const summaryBlank = useSessions(state => state.byId[sessionId]?.blank);
    const settling = !active && session.openState === 'loading' && summaryBlank !== true;
    // A side conversation has a bound cwd and a real Session already. No new-chat
    // hero/workspace picker here. Crucially: fix views to Chat, exactly as native
    // ui-subagent does, rather than inheriting the MAIN view's selected tab.
    return renderFactorySlot('conversation.content', {
      variant: 'embedded', phase: settling ? 'settling' : 'active', hero: false,
    }, { slots: { views: FixedChatConversationView } });
  }
  function SideChatTab(props) {
    const { tab, panel } = props.useTabInfo();
    const resource = props.useResource(tab.contentId);
    const parsed = parseChatAddress(tab.contentId);
    const [error, setError] = React.useState('');
    const [phase, setPhase] = React.useState('open');
    React.useEffect(() => {
      if (!parsed) return undefined;
      const key = occurrenceKey(props.sessionId, tab.id);
      const held = { close: () => tab.actions.close(), signal: tab.signal };
      tabClosers.set(key, held);
      const sync = () => { setPhase(client.state(parsed.sessionId)); setError(client.error(parsed.sessionId)); };
      const off = client.subscribe(sync); sync();
      if (!client.has(parsed.sessionId)) void client.recover(parsed.sessionId, props.sessionId)
        .catch(() => setError('这是宿主重启前的侧聊：记录保留，关闭仅释放视图，不自动删历史。'));
      return () => { off(); if (tabClosers.get(key) === held) tabClosers.delete(key); };
    }, [tab.id, parsed?.sessionId, props.sessionId]);
    React.useEffect(() => {
      if (parsed) return undefined;
      // The Start card opens a PAGE, not a Session resource. One async operation
      // per native occurrence; StrictMode remounts reuse it and never fork again.
      let live = true;
      if (!pageTasks.has(tab.id)) {
        const task = client.open(tab.id, props.sessionId).then(async value => {
          if (tab.signal.aborted) { await client.close(value.sessionId); return; }
          const target = ctx.sidebarRight.commandTarget(null);
          if (target?.sessionId !== props.sessionId) throw new Error('主会话已切换，请切回后重试；没有改动新会话');
          ctx.sidebarRight.openResource(chatAddress(value.sessionId), {
            kind: SIDE_CHAT_KIND, paneId: panel.id, replaceTab: tab.id, revealIfOpened: false,
          });
        });
        pageTasks.set(tab.id, task);
        task.catch(() => { pageTasks.delete(tab.id); });
      }
      pageTasks.get(tab.id).catch(failure => { if (live) setError(failure.message); });
      return () => { live = false; };
    }, [tab.id, tab.contentId, props.sessionId]);
    if (!parsed) return h('div', { className: 'dsh-side-chat__status', role: 'status' }, error || '正在打开原生侧聊…');
    if (!resource?.value?.reference) return h('div', { className: 'dsh-side-chat__status', role: 'status' }, error || resource?.error?.message || '正在连接侧聊会话…');
    const notice = phase === 'promoting' ? '正在转为主会话，保留聊天记录…'
      : phase === 'promoted' ? '已保留为主会话；关闭此标签只释放视图，不删除记录。'
      : phase === 'closing' ? '正在停止并清理这个侧聊…' : '';
    return h('div', { className: 'dsh-side-chat-native', 'data-sidebar-chat': '' },
      error || notice ? h('div', { className: 'dsh-side-chat__notice', role: 'status' }, error || notice) : null,
      h('div', { className: 'dsh-side-chat__body' },
        h(props.SessionProvider, { session: resource.value.reference }, props.renderSlot(SIDE_CHAT_BODY_SLOT, {}))));
  }
  ctx.effect(() => ctx.resources.register(resourceProvider(ctx.sessions)), 'side-chat: resource owner');
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: SIDE_CHAT_ID, kind: SIDE_CHAT_KIND,
    multiple: true, keepMounted: true,
    patterns: [SIDE_CHAT_ADDRESS + '**'], canOpen: address => !!parseChatAddress(address), title: () => '侧边聊天',
    guide: [{ id: 'open', order: 40, title: () => '侧边聊天', description: () => '独立提问，打开时参考主聊文本，不继承待办或自动续跑。', icon: SideChatGuideIcon }],
  }), 'side-chat: tab type');
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: SIDE_CHAT_ID,
    children: { [SIDE_CHAT_BODY_SLOT]: { kind: 'single', scope: 'session' } },
  }, SideChatTab)), 'side-chat: tab body');
  ctx.effect(() => ctx.slots.inject(SIDE_CHAT_BODY_SLOT, () => ctx.slots.register({ name: SIDE_CHAT_BODY_SLOT }, ConversationPanel)), 'side-chat: native conversation');
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.menu.item', () => ctx.slots.register({
    name: 'sidebar.right.tab.menu.item', id: SIDE_CHAT_ID, order: 40,
  }, PromoteMenuItem)), 'side-chat: promote menu');
  ctx.effect(() => ctx.sidebarRight.registerCloseHandler(SIDE_CHAT_KIND, (parentId, tab) => {
    const parsed = parseChatAddress(tab.contentId);
    if (!parsed) return;
    if (client.state(parsed.sessionId) === 'promoting') throw new Error('正在转为主会话，请稍候；未删除聊天记录');
    if (!client.has(parsed.sessionId) || ['closed', 'promoted'].includes(client.state(parsed.sessionId))) return;
    // A native duplicated tab may show the SAME resource. Closing one occurrence
    // is not permission to delete a Session still shown by another occurrence.
    if (typeof ctx.sidebarRight.tabsIn === 'function'
      && ctx.sidebarRight.tabsIn(parentId).filter(other => other.contentId === tab.contentId).length > 1) return;
    // Native close hooks are SYNCHRONOUS. Retain this tab until async cleanup
    // confirms success; then re-enter close via the occurrence's bound action.
    const closeView = tabClosers.get(occurrenceKey(parentId, tab.id))?.close;
    void client.close(parsed.sessionId).then(() => closeView?.(), () => {});
    throw new Error('正在安全清理侧聊；清理成功后标签会自动关闭，失败时原标签保留');
  }), 'side-chat: explicit-close cleanup');
}
