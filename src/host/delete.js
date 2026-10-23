// Explicit-close cleanup ONLY for a handle minted and retained by service.js.
// No arbitrary session registration, factory interception, other-plugin RPC or
// browser-unload deletion. Native data roots are discovered, never configured.
import fs from 'node:fs';
import path from 'node:path';

export class DeleteError extends Error {
  constructor(code, message, status = 409) { super(message); this.code = `sidechat/${code}`; this.status = status; }
}
const refuse = (code, message) => { throw new DeleteError(code, message); };
const norm = value => process.platform === 'win32' ? value.toLowerCase() : value;
function directory(value) {
  const absolute = path.resolve(value), info = fs.lstatSync(absolute);
  if (!info.isDirectory() || info.isSymbolicLink() || norm(fs.realpathSync(absolute)) !== norm(absolute)) refuse('unsafe-path', '路径包含链接或重定向，未删除文件');
  return absolute;
}
function targets(root, id) {
  if (!fs.existsSync(root)) return [];
  directory(root);
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) refuse('unsafe-path', '日志根目录中存在链接，无法证明删除目标安全，保留记录');
    if (!entry.isDirectory()) continue;
    const bucket = path.join(root, entry.name), candidate = path.join(bucket, id);
    try { fs.lstatSync(candidate); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    directory(bucket); directory(candidate);
    if (path.dirname(path.dirname(candidate)) !== root || path.basename(candidate) !== id) refuse('unsafe-path', '会话目录越界，未删除文件');
    result.push(candidate);
  }
  if (result.length > 1) refuse('ambiguous', '会话日志目录不唯一，未删除文件');
  return result;
}
async function activity(ctx, id) {
  if (typeof ctx.waterfall !== 'function') refuse('activity-unavailable', '无法核对后台活动，未删除文件');
  const active = await ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([]));
  if (!Array.isArray(active)) refuse('activity-unavailable', '后台活动状态无效，未删除文件');
  return active;
}
export async function removeOwnedSession(ctx, entry) {
  const { id, handle } = entry;
  if (!/^sidechat-[0-9a-f-]{36}$/.test(id) || handle?.agent?.id !== id || typeof handle.dispose !== 'function') refuse('not-owned', '侧聊所有权无效，未操作任何会话');
  const get = name => ctx.get(name);
  const agents = get('agents'), sessions = get('sessions'), registry = get('workspaceRegistry');
  const root = entry.root;
  if (typeof root !== 'string' || !path.isAbsolute(root) || get('sessionPersistence')?.root !== root) refuse('storage-unavailable', '存储已更换，保留侧聊记录');
  if (!registry || !['archiveSession','unarchiveSession','unpinSession','list'].every(key => typeof registry[key] === 'function')) refuse('workspace-unavailable', '工作区接口不可用，未删除文件');
  const table = get('storageDomain')?.get('session_projcache')?.table('sessions');
  if (typeof table?.delete !== 'function') refuse('index-unavailable', '投影索引不可用，未删除文件');
  const workspaces = registry.list();
  if (!Array.isArray(workspaces) || workspaces.some(ws => typeof ws.detachSession !== 'function')) refuse('workspace-unavailable', '工作区清理接口不可用，未删除文件');
  // Preflight EVERY path and index before stopping or deleting anything.
  targets(path.resolve(root), id);
  const live = agents.get(id), attached = sessions.get(id);
  if (live && live !== handle.agent || attached && attached !== handle.agent.session) refuse('owner-changed', '原生句柄已更换，未删除文件');
  // Explicit user close can stop this side-chat only. Archiving at close prevents
  // late queued model steps; NEVER archive while the side-chat is open.
  if (live) await registry.archiveSession(id, { stopActivity: true });
  await handle.dispose();
  if (agents.get(id) || sessions.get(id) || (await activity(ctx, id)).length) refuse('busy', '侧聊尚未停止，日志保留，可稍后重试');
  const directories = targets(path.resolve(root), id);
  // No await between the final liveness/path checks and exact-directory removal.
  if (agents.get(id) || sessions.get(id)) refuse('owner-changed', '侧聊被重新打开，未删除文件');
  let filesRemoved = false;
  try {
    for (const target of directories) {
      directory(target);
      if (path.dirname(path.dirname(target)) !== path.resolve(root) || path.basename(target) !== id) refuse('unsafe-path', '删除目标校验失败');
      fs.rmSync(target, { recursive: true, force: false }); filesRemoved = true;
    }
    await table.delete(id);
    for (const workspace of workspaces) await workspace.detachSession(id);
    await registry.unpinSession(id);
    await registry.unarchiveSession(id);
  } catch (error) {
    if (filesRemoved) throw new DeleteError('partial-cleanup', '侧聊日志已删除，但索引清理未完成；请勿盲目重试', 500);
    throw error;
  }
}
