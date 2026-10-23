import React from 'react';
import { MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives';
import { sideChatStyles } from './styles.js';
import { createSideChatClient, installNativeSideChat, SIDE_CHAT_ID, SIDE_CHAT_KIND } from './native.js';
export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'sessions', 'resources', 'connection', 'uiWorkspace'];
const h = React.createElement;
export function install(ctx) {
  const client = createSideChatClient(ctx.connection);
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = SIDE_CHAT_ID; style.textContent = sideChatStyles;
    document.head.appendChild(style);
    return () => style.remove();
  }, 'side-chat: shell styles');
  installNativeSideChat(ctx, { React, client, MenuItemButton });
  function OpenSideChat(props) {
    const [error, setError] = React.useState('');
    function open(event) {
      try {
        const target = ctx.sidebarRight.commandTarget(event.currentTarget);
        if (target?.sessionId !== props.sessionId) throw new Error('当前主会话不可用，未创建侧聊');
        // Header and Start card use precisely the SAME native opening path.
        ctx.sidebarRight.openTabFromTarget(SIDE_CHAT_KIND, target); setError('');
      } catch (failure) { setError(failure.message); }
    }
    return h('span', { className: 'dsh-side-chat__entry' },
      h('button', { type: 'button', className: 'dsh-side-chat__open', onClick: open,
        title: error || '打开独立侧聊，参考主聊文本，不接管主任务', 'aria-label': '新建侧边聊天' }, '侧边聊天'),
      error ? h('span', { className: 'dsh-side-chat__notice', role: 'alert' }, error) : null);
  }
  ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: SIDE_CHAT_ID, order: 40,
  }, OpenSideChat)), 'side-chat: header entry');
}
export function apply(ctx) {
  try { install(ctx); }
  catch (error) { console.error('[side-chat] 原生侧聊注册失败，保留 DSH 其余界面：', error); }
}
