// No transcript/composer replicas or global rules: DSH owns the native UI.
export const sideChatStyles = `
.dsh-side-chat-native{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;min-width:0;overflow:hidden}
.dsh-side-chat__body{display:flex;flex:1;width:100%;min-height:0;min-width:0;overflow:hidden}
.dsh-side-chat__body>[data-conversation-content]{flex:1;min-width:0;min-height:0}
/* Empty native Chat has no growing view; retain its sticky seat and consume only free space. */
.dsh-side-chat-native [data-conversation-scroll]>[data-composer-seat]{margin-top:auto}
.dsh-side-chat__status{display:flex;align-items:center;justify-content:center;width:100%;height:100%;padding:20px;font-size:12px;color:var(--dsw-alias-label-secondary,#686c78);overflow-wrap:anywhere}
.dsh-side-chat__notice{flex:none;margin:6px 10px;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2,#ccc);border-radius:8px;font-size:12px;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,#686c78)}
.dsh-side-chat__entry{display:inline-flex;align-items:center;gap:6px;min-width:0}
.dsh-side-chat__open{border:1px solid var(--dsw-alias-border-l2,#ccc);background:transparent;color:var(--dsw-alias-label-primary,inherit);border-radius:8px;padding:4px 9px;display:inline-flex;align-items:center;font:12px/1.4 system-ui,sans-serif;cursor:pointer;white-space:nowrap}
.dsh-side-chat__open:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.1))}
.dsh-side-chat__open:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#607bf0);outline-offset:2px}
`;
