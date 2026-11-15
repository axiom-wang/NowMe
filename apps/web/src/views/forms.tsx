/**
 * 表单小组件。所有改变状态的请求都是 POST，并带 `_csrf`（contracts 4.2）。
 */
import { CSRF_FIELD_NAME } from '@nowme/contracts';
import type { FC, PropsWithChildren } from 'hono/jsx';

export const CsrfField: FC<{ token: string }> = ({ token }) => <input type="hidden" name={CSRF_FIELD_NAME} value={token} />;

export interface PostButtonProps {
  action: string;
  csrf: string;
  label: string;
  /** 按钮样式：`primary` / `ghost` / `danger`。 */
  variant?: 'primary' | 'ghost' | 'danger';
  /** 提交前弹出确认（由 app.js 处理）。 */
  confirm?: string;
  /** 额外的隐藏字段。 */
  fields?: Record<string, string>;
}

/** 只有一个按钮的 POST 表单。 */
export const PostButton: FC<PostButtonProps> = ({ action, csrf, label, variant = 'ghost', confirm, fields }) => (
  <form method="post" action={action} class="inline-form" data-confirm={confirm}>
    <CsrfField token={csrf} />
    {Object.entries(fields ?? {}).map(([name, value]) => (
      <input type="hidden" name={name} value={value} />
    ))}
    <button type="submit" class={`btn btn--${variant}`}>
      {label}
    </button>
  </form>
);

/** 提示条。`id` 用于让出错的控件通过 `aria-describedby` 指向它（配合控件上的 `aria-invalid`）。 */
export const Notice: FC<PropsWithChildren<{ tone?: 'info' | 'success' | 'warning' | 'error'; id?: string }>> = ({ tone = 'info', id, children }) => (
  <p class={`notice notice--${tone}`} id={id} role={tone === 'error' ? 'alert' : 'status'}>
    {children}
  </p>
);
