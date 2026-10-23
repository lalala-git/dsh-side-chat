import { createSideChatService, SideChatError } from './service.js';
import { DeleteError } from './delete.js';
export const name = 'side-chat';
export const inject = ['connection', 'agents', 'sessions', 'sessionQuery', 'agentDefaultModel', 'workspaceRegistry'];
const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
export function registerRoutes(ctx, service) {
  for (const operation of ['open', 'recover', 'promote', 'close', 'register', 'delete']) {
    const method = `sideChatNative.${operation}`;
    ctx.connection.fetch.register({ path: '/api/' + method, methods: ['POST'], requestBody: 'buffered',
      async fetch(request) {
        if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return new Response('JSON required', { status: 415, headers: HEADERS });
        let envelope;
        try {
          const text = await request.text();
          if (text.length > 16384) return new Response('Request too large', { status: 413, headers: HEADERS });
          envelope = JSON.parse(text);
        } catch { return new Response('Invalid JSON', { status: 400, headers: HEADERS }); }
        if (envelope?.type !== 'client-request' || typeof envelope.rpcId !== 'string' || envelope.rpcId.length > 200 || envelope.method !== method) return new Response('Invalid RPC envelope', { status: 400, headers: HEADERS });
        let result;
        try {
          request.signal.throwIfAborted();
          if (operation === 'register' || operation === 'delete') throw new SideChatError('legacy-disabled', '旧的任意会话登记/删除接口已停用，未删除数据', 410);
          result = { ok: true, value: await service[operation](envelope.payload) };
        } catch (error) {
          const known = error instanceof SideChatError || error instanceof DeleteError;
          result = { ok: false, error: { code: known ? error.code : 'sidechat/unavailable',
            message: known ? error.message : '原生侧聊服务暂不可用；保留现有数据，请检查插件版本', details: { status: known ? error.status : 503 } } };
        }
        return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result }, { headers: HEADERS });
      },
    });
  }
}
export function apply(ctx) {
  const service = createSideChatService(ctx);
  ctx.effect(() => () => service.dispose(), 'side-chat: owned handles');
  registerRoutes(ctx, service);
}
