/**
 * 登录后的跳转地址 `next`：只允许站内相对路径（防开放重定向）。
 * 拒绝 `//evil`、`/\evil`、`https://...`、`javascript:`、控制字符等；不合法时回到 `/`。
 */
const MAX_NEXT_LENGTH = 512;

export function safeNextPath(next: string | undefined | null, webOrigin: string): string {
  if (typeof next !== 'string' || next.length === 0 || next.length > MAX_NEXT_LENGTH) return '/';
  if (!next.startsWith('/') || next.startsWith('//')) return '/';
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return '/';
  let url: URL;
  try {
    url = new URL(next, webOrigin);
  } catch {
    return '/';
  }
  if (url.origin !== webOrigin) return '/';
  // 登录相关页面本身不作为跳转目标，避免来回跳
  if (url.pathname === '/login' || url.pathname.startsWith('/login/') || url.pathname === '/logout') return '/';
  return `${url.pathname}${url.search}${url.hash}`;
}

/** `/login?next=<当前路径>`。 */
export function loginRedirectPath(currentPath: string, webOrigin: string): string {
  const next = safeNextPath(currentPath, webOrigin);
  return next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`;
}
