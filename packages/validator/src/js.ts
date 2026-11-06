/**
 * 脚本分析（内联 `<script>`、`type="module"`、`on*` 事件属性）。
 *
 * 用 acorn 解析成 AST，再用带作用域的遍历器检查：
 * - FORBIDDEN_API：只看真正引用全局对象的标识符 / 成员访问 / 调用 / new（注释和普通字符串不算）；
 *   `window['localStorage']`、`window["local" + "Storage"]`、`const w = window; w.fetch` 这类
 *   能静态折叠的写法也能识别。无法静态判定的（运行时拼出的属性名等）由 CSP 与沙箱兜底。
 * - 外链：`nowme.openLink(...)` / `setAttribute('data-nm-href', ...)` / `dataset.nmHref =` 的字面量必须是 https:；
 *   其他字符串里的 http(s):// 报 EXTERNAL_URL_IN_SCRIPT 警告。
 * - 动效：requestAnimationFrame、`.animate(`、Canvas + setInterval 等需要检查减少动效设置。
 * - 字符：收集字符串里的中文字符（manifest.extraChars）、assets/ 路径、Kit 字体名。
 * - HTML 注入点（innerHTML、insertAdjacentHTML、document.write 等）的静态 HTML 交给 HTML 检查。
 */
import {
  parse,
  type AnyNode,
  type AssignmentExpression,
  type CallExpression,
  type Class,
  type Expression,
  type Function as FunctionNode,
  type Identifier,
  type Literal,
  type MemberExpression,
  type NewExpression,
  type Node,
  type ObjectPattern,
  type Pattern,
  type Program,
  type SpreadElement,
  type Statement,
  type ModuleDeclaration,
} from 'acorn';
import type { PageAnalysis } from './analysis.js';
import { findKitFontVars } from './fonts.js';
import { API_HINTS, HINTS, forbiddenElementHint, type ApiCategory } from './messages.js';
import { DYNAMIC_PLACEHOLDER, isHttpsUrl } from './refs.js';
import { addCjkChars, clip } from './text.js';

export interface ScriptSource {
  code: string;
  /** 脚本第 1 行在 index.html 中的行号。 */
  line: number | undefined;
  /** `handler`：事件属性（函数体，可 return，隐含参数 event）。 */
  kind: 'classic' | 'module' | 'handler';
  /** 展示用位置，例如 `<script>`、`onclick 属性`。 */
  where: string;
  /** 由脚本拼出的 HTML 还原的近似代码：解析失败不报 JS_SYNTAX_ERROR。 */
  approximate?: boolean;
}

// ---------------------------------------------------------------------------
// 名单
// ---------------------------------------------------------------------------

/** 名字本身足够特殊：在任何对象上访问、或作为全局标识符引用都报。 */
const DISTINCTIVE_APIS: Readonly<Record<string, ApiCategory>> = {
  XMLHttpRequest: 'network',
  WebSocket: 'network',
  EventSource: 'network',
  RTCPeerConnection: 'network',
  webkitRTCPeerConnection: 'network',
  mozRTCPeerConnection: 'network',
  WebTransport: 'network',
  sendBeacon: 'network',
  importScripts: 'network',
  localStorage: 'storage',
  sessionStorage: 'storage',
  indexedDB: 'storage',
  webkitIndexedDB: 'storage',
  mozIndexedDB: 'storage',
  cookieStore: 'storage',
  openDatabase: 'storage',
  serviceWorker: 'worker',
  getUserMedia: 'device',
  webkitGetUserMedia: 'device',
  mozGetUserMedia: 'device',
  getDisplayMedia: 'device',
  geolocation: 'device',
};

/** 作为未声明的全局标识符引用时就报（`fetch(...)`、`const f = fetch`、`(0, eval)(...)`）。 */
const GLOBAL_IDENTIFIER_APIS: Readonly<Record<string, ApiCategory>> = {
  fetch: 'network',
  eval: 'eval',
  caches: 'storage',
};

/** 在全局对象（window / self / globalThis / frames 及其别名）上访问时报。 */
const GLOBAL_MEMBER_APIS: Readonly<Record<string, { label: string; category: ApiCategory }>> = {
  fetch: { label: 'fetch', category: 'network' },
  eval: { label: 'eval', category: 'eval' },
  caches: { label: 'caches', category: 'storage' },
  open: { label: 'window.open', category: 'navigation' },
  top: { label: 'window.top', category: 'navigation' },
  Function: { label: 'Function', category: 'eval' },
  Worker: { label: 'Worker', category: 'worker' },
  SharedWorker: { label: 'SharedWorker', category: 'worker' },
};

const GLOBAL_ALIASES: ReadonlySet<string> = new Set(['window', 'self', 'globalThis', 'frames']);
const TOP_ALIASES: ReadonlySet<string> = new Set(['top', 'parent', 'opener']);
const RAF_NAMES: ReadonlySet<string> = new Set(['requestAnimationFrame', 'webkitRequestAnimationFrame', 'mozRequestAnimationFrame']);
const TIMER_NAMES: ReadonlySet<string> = new Set(['setTimeout', 'setInterval']);
/** 脚本动态创建这些元素等同于在 HTML 里写它们。 */
const FORBIDDEN_CREATED_ELEMENTS: ReadonlySet<string> = new Set([
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'form',
  'base',
  'portal',
  'fencedframe',
  'link',
  'meta',
]);
/** 赋值即解析 HTML 的属性。 */
const HTML_SINK_PROPERTIES: ReadonlySet<string> = new Set(['innerHTML', 'outerHTML', 'srcdoc']);
/** 常用的 XML 命名空间（createElementNS 等），不是外部地址。 */
const XML_NAMESPACES: ReadonlySet<string> = new Set([
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/1999/xhtml',
  'http://www.w3.org/1999/xlink',
  'http://www.w3.org/1998/Math/MathML',
  'http://www.w3.org/XML/1998/namespace',
  'http://www.w3.org/2000/xmlns/',
]);

const CATEGORY_REASON: Record<ApiCategory, string> = {
  network: '页面不能联网',
  storage: '页面不能存储数据',
  navigation: '页面不能跳转或打开新窗口',
  eval: '不能执行字符串形式的代码',
  worker: '页面不能创建 Worker',
  device: '页面不能访问设备',
};

// ---------------------------------------------------------------------------
// 作用域
// ---------------------------------------------------------------------------

type BindingKind = 'var' | 'let' | 'const' | 'function' | 'class' | 'param' | 'catch' | 'import';

interface Binding {
  kind: BindingKind;
  /** 简单标识符声明的初始值（用于别名与常量折叠）。 */
  init: Expression | null;
  scope: Scope;
}

class Scope {
  readonly bindings = new Map<string, Binding>();

  constructor(readonly parent: Scope | null) {}

  declare(name: string, kind: BindingKind, init: Expression | null = null): void {
    if (!this.bindings.has(name)) this.bindings.set(name, { kind, init, scope: this });
  }

  lookup(name: string): Binding | null {
    for (let scope: Scope | null = this; scope !== null; scope = scope.parent) {
      const binding = scope.bindings.get(name);
      if (binding) return binding;
    }
    return null;
  }
}

function forEachPatternIdentifier(pattern: Pattern | null | undefined, visit: (id: Identifier) => void): void {
  if (!pattern) return;
  switch (pattern.type) {
    case 'Identifier':
      visit(pattern);
      return;
    case 'ObjectPattern':
      for (const prop of pattern.properties) {
        if (prop.type === 'RestElement') forEachPatternIdentifier(prop.argument, visit);
        else forEachPatternIdentifier(prop.value, visit);
      }
      return;
    case 'ArrayPattern':
      for (const element of pattern.elements) forEachPatternIdentifier(element, visit);
      return;
    case 'AssignmentPattern':
      forEachPatternIdentifier(pattern.left, visit);
      return;
    case 'RestElement':
      forEachPatternIdentifier(pattern.argument, visit);
      return;
    default:
      return;
  }
}

function declareVariable(scope: Scope, kind: BindingKind, id: Pattern, init: Expression | null | undefined): void {
  if (id.type === 'Identifier') scope.declare(id.name, kind, init ?? null);
  else forEachPatternIdentifier(id, (inner) => scope.declare(inner.name, kind));
}

type StatementLike = Statement | ModuleDeclaration;

function blockBody(node: { body: unknown }): StatementLike[] {
  return node.body as StatementLike[];
}

/** var 声明与函数声明提升到函数作用域（不进入嵌套函数；块内函数按 Annex B 也提升）。 */
function hoistVars(statements: readonly StatementLike[], scope: Scope): void {
  for (const statement of statements) hoistStatement(statement, scope);
}

function hoistStatement(node: StatementLike | null | undefined, scope: Scope): void {
  if (!node) return;
  switch (node.type) {
    case 'VariableDeclaration':
      if (node.kind === 'var') for (const decl of node.declarations) declareVariable(scope, 'var', decl.id, decl.init);
      return;
    case 'FunctionDeclaration':
      if (node.id) scope.declare(node.id.name, 'function');
      return;
    case 'BlockStatement':
      hoistVars(blockBody(node), scope);
      return;
    case 'IfStatement':
      hoistStatement(node.consequent, scope);
      hoistStatement(node.alternate, scope);
      return;
    case 'ForStatement':
      if (node.init?.type === 'VariableDeclaration') hoistStatement(node.init, scope);
      hoistStatement(node.body, scope);
      return;
    case 'ForInStatement':
    case 'ForOfStatement':
      if (node.left.type === 'VariableDeclaration') hoistStatement(node.left, scope);
      hoistStatement(node.body, scope);
      return;
    case 'WhileStatement':
    case 'DoWhileStatement':
    case 'LabeledStatement':
    case 'WithStatement':
      hoistStatement(node.body, scope);
      return;
    case 'TryStatement':
      hoistStatement(node.block, scope);
      if (node.handler) hoistStatement(node.handler.body, scope);
      hoistStatement(node.finalizer, scope);
      return;
    case 'SwitchStatement':
      for (const switchCase of node.cases) hoistVars(switchCase.consequent, scope);
      return;
    case 'ExportNamedDeclaration':
      if (node.declaration) hoistStatement(node.declaration, scope);
      return;
    case 'ExportDefaultDeclaration':
      if (node.declaration.type === 'FunctionDeclaration' && node.declaration.id) scope.declare(node.declaration.id.name, 'function');
      return;
    default:
      return;
  }
}

/** 块级声明（let / const / class / 块内函数 / import）。 */
function declareLexical(statements: readonly StatementLike[], scope: Scope): void {
  for (const statement of statements) {
    let node: AnyNode | null | undefined = statement;
    if (statement.type === 'ExportNamedDeclaration') node = statement.declaration;
    else if (statement.type === 'ExportDefaultDeclaration') node = statement.declaration;
    if (!node) continue;
    if (node.type === 'VariableDeclaration' && node.kind !== 'var') {
      const kind: BindingKind = node.kind === 'const' ? 'const' : 'let';
      for (const decl of node.declarations) declareVariable(scope, kind, decl.id, decl.init);
    } else if (node.type === 'ClassDeclaration' && node.id) {
      scope.declare(node.id.name, 'class');
    } else if (node.type === 'FunctionDeclaration' && node.id) {
      scope.declare(node.id.name, 'function');
    } else if (node.type === 'ImportDeclaration') {
      for (const spec of node.specifiers) scope.declare(spec.local.name, 'import');
    }
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

const SYNTAX_TRANSLATIONS: [RegExp, string][] = [
  [/^Unterminated string constant/, '字符串缺少结束引号'],
  [/^Unterminated template/, '模板字符串缺少结束反引号'],
  [/^Unterminated regular expression/, '正则表达式没有结束'],
  [/^Unterminated comment/, '注释没有结束（缺少 */）'],
  [/^'import' and 'export' may appear only with 'sourceType: module'/, 'import / export 只能用在 <script type="module"> 里'],
  [/^Cannot use keyword 'await' outside an async function/, 'await 只能用在 async 函数里'],
  [/^Identifier '(.+)' has already been declared/, '变量 $1 重复声明'],
  [/^Unexpected character '(.+)'/, '意外的字符 $1'],
  [/^Unexpected token/, '意外的符号'],
  [/^'return' outside of function/, 'return 只能写在函数里'],
];

function translateSyntaxError(message: string): string {
  const base = message.replace(/\s*\(\d+:\d+\)$/, '');
  for (const [pattern, replacement] of SYNTAX_TRANSLATIONS) {
    if (pattern.test(base)) return base.replace(pattern, replacement);
  }
  return base;
}

/** 解析期间发现的新脚本（注入点里的事件属性、setAttribute('on…') 的字符串）上限，防止无限递归。 */
const MAX_DYNAMIC_SCRIPTS = 200;

/**
 * 分析一组脚本。`onHtmlSink` 收到注入点里拼出的静态 HTML（由 HTML 检查器以“注入”模式检查，
 * 其中的事件属性等会再交回本函数的队列）。
 */
export function analyzeScripts(
  sources: readonly ScriptSource[],
  a: PageAnalysis,
  onHtmlSink: (html: string, line: number | undefined, where: string) => ScriptSource[],
): void {
  const parsed: { source: ScriptSource; program: Program }[] = [];
  const parseOne = (source: ScriptSource): Program | null => {
    try {
      return parse(source.code, {
        ecmaVersion: 'latest',
        sourceType: source.kind === 'module' ? 'module' : 'script',
        locations: true,
        allowReturnOutsideFunction: source.kind === 'handler',
        allowHashBang: false,
      });
    } catch (error) {
      if (!source.approximate) reportSyntaxError(source, error, a);
      return null;
    }
  };
  for (const source of sources) {
    const program = parseOne(source);
    if (program) parsed.push({ source, program });
  }

  // 经典脚本的顶层声明在同一个全局作用域里，彼此可见，事件属性也能看到
  const global = new Scope(null);
  for (const { source, program } of parsed) {
    if (source.kind !== 'classic') continue;
    hoistVars(program.body, global);
    declareLexical(program.body, global);
  }

  const queue: ScriptSource[] = [];
  const sink = (html: string, line: number | undefined, where: string) => {
    for (const extra of onHtmlSink(html, line, where)) queue.push(extra);
  };
  const run = (source: ScriptSource, program: Program) => {
    try {
      new JsWalker(source, a, global, sink, queue).run(program);
    } catch (error) {
      if (error instanceof RangeError) {
        a.issues.add('JS_SYNTAX_ERROR', a.file, source.line, `${source.where} 嵌套过深，无法分析`, HINTS.jsSyntax);
        return;
      }
      throw error;
    }
  };
  for (const { source, program } of parsed) run(source, program);
  let processed = 0;
  while (queue.length > 0 && processed < MAX_DYNAMIC_SCRIPTS) {
    const source = queue.shift() as ScriptSource;
    processed += 1;
    const program = parseOne(source);
    if (program) run(source, program);
  }
}

function reportSyntaxError(source: ScriptSource, error: unknown, a: PageAnalysis): void {
  const loc = (error as { loc?: { line?: number } }).loc;
  const line = source.line === undefined ? undefined : source.line + (loc?.line ?? 1) - 1;
  const raw = error instanceof Error ? error.message : String(error);
  const reason = error instanceof RangeError ? '嵌套过深' : translateSyntaxError(raw);
  a.issues.add('JS_SYNTAX_ERROR', a.file, line, `${source.where} 无法解析：${reason}`, HINTS.jsSyntax);
}

// ---------------------------------------------------------------------------
// 遍历器
// ---------------------------------------------------------------------------

type Value = string | number;

class JsWalker {
  /** >0 时字符串里的外部地址是外链参数，不报 EXTERNAL_URL_IN_SCRIPT。 */
  private exemptUrl = 0;
  private thisIsGlobal: boolean;

  constructor(
    private readonly source: ScriptSource,
    private readonly a: PageAnalysis,
    private readonly global: Scope,
    private readonly sink: (html: string, line: number | undefined, where: string) => void,
    private readonly queue: ScriptSource[],
  ) {
    this.thisIsGlobal = source.kind === 'classic';
  }

  run(program: Program): void {
    let scope = this.global;
    if (this.source.kind !== 'classic') {
      scope = new Scope(this.global);
      if (this.source.kind === 'handler') scope.declare('event', 'param');
      hoistVars(program.body, scope);
      declareLexical(program.body, scope);
    }
    for (const statement of program.body) this.visit(statement, scope);
  }

  // ----- 工具 -------------------------------------------------------------

  private lineOf(node: Node): number | undefined {
    if (this.source.line === undefined) return undefined;
    return this.source.line + (node.loc?.start.line ?? 1) - 1;
  }

  private api(label: string, category: ApiCategory, node: Node): void {
    this.a.issues.add(
      'FORBIDDEN_API',
      this.a.file,
      this.lineOf(node),
      `${this.source.where} 使用了 ${label}：${CATEGORY_REASON[category]}`,
      API_HINTS[category],
      label,
    );
  }

  private fontFace(node: Node, what: string): void {
    this.a.issues.add('FONT_FACE_FORBIDDEN', this.a.file, this.lineOf(node), `${this.source.where} ${what}：页面不能自带字体`, HINTS.fontFace, what);
  }

  private propName(member: MemberExpression, scope: Scope): string | null {
    if (!member.computed) return member.property.type === 'Identifier' ? member.property.name : null;
    const value = this.fold(member.property as Expression, scope);
    return value === null ? null : String(value);
  }

  /** 去掉不影响取值的包装：`(a, b)` 取 b、`a?.b` 取内部表达式、`x = y` 取 y。 */
  private unwrap(node: Expression | SpreadElement | null | undefined): Expression | null {
    let current: AnyNode | null | undefined = node;
    for (let i = 0; i < 16 && current; i += 1) {
      if (current.type === 'ChainExpression' || current.type === 'ParenthesizedExpression') current = current.expression;
      else if (current.type === 'SequenceExpression') current = current.expressions[current.expressions.length - 1];
      else if (current.type === 'AssignmentExpression' && current.operator === '=') current = current.right;
      else break;
    }
    if (!current || current.type === 'SpreadElement') return null;
    return current as Expression;
  }

  /**
   * 标识符的含义：`global`（未声明，指向全局对象上的同名属性）、`alias`（声明时有初始值，
   * 跟随初始值判断）、`local`（其他本地变量）。
   */
  private resolve(name: string, scope: Scope): { kind: 'global' } | { kind: 'alias'; init: Expression; scope: Scope } | { kind: 'local' } {
    const binding = scope.lookup(name);
    if (!binding) return { kind: 'global' };
    if (binding.init && binding.kind !== 'function' && binding.kind !== 'param') return { kind: 'alias', init: binding.init, scope: binding.scope };
    return { kind: 'local' };
  }

  /** 是否指向全局对象（window、self、globalThis、frames、`document.defaultView`、经典脚本顶层的 this 及其别名）。 */
  private isGlobalObject(node: Expression | Node | null | undefined, scope: Scope, depth = 0): boolean {
    if (!node || depth > 8) return false;
    const expr = this.unwrap(node as Expression);
    if (!expr) return false;
    switch (expr.type) {
      case 'Identifier': {
        const r = this.resolve(expr.name, scope);
        if (r.kind === 'global') return GLOBAL_ALIASES.has(expr.name);
        if (r.kind === 'alias') return this.isGlobalObject(r.init, r.scope, depth + 1);
        return false;
      }
      case 'ThisExpression':
        return this.thisIsGlobal;
      case 'MemberExpression': {
        if (expr.object.type === 'Super') return false;
        const prop = this.propName(expr, scope);
        if (prop !== null && GLOBAL_ALIASES.has(prop)) return this.isGlobalObject(expr.object, scope, depth + 1) || this.isTopLike(expr.object, scope, depth + 1);
        if (prop === 'defaultView') return this.isDocument(expr.object, scope, depth + 1);
        return false;
      }
      case 'LogicalExpression':
        return this.isGlobalObject(expr.left, scope, depth + 1) || this.isGlobalObject(expr.right, scope, depth + 1);
      case 'ConditionalExpression':
        return this.isGlobalObject(expr.consequent, scope, depth + 1) || this.isGlobalObject(expr.alternate, scope, depth + 1);
      default:
        return false;
    }
  }

  /** 是否指向外层窗口（top、parent、opener 及 `window.top` 等）。 */
  private isTopLike(node: Expression | Node | null | undefined, scope: Scope, depth = 0): boolean {
    if (!node || depth > 8) return false;
    const expr = this.unwrap(node as Expression);
    if (!expr) return false;
    switch (expr.type) {
      case 'Identifier': {
        const r = this.resolve(expr.name, scope);
        if (r.kind === 'global') return TOP_ALIASES.has(expr.name);
        if (r.kind === 'alias') return this.isTopLike(r.init, r.scope, depth + 1);
        return false;
      }
      case 'MemberExpression': {
        if (expr.object.type === 'Super') return false;
        const prop = this.propName(expr, scope);
        if (prop !== null && TOP_ALIASES.has(prop)) return this.isGlobalObject(expr.object, scope, depth + 1) || this.isTopLike(expr.object, scope, depth + 1);
        if (prop !== null && GLOBAL_ALIASES.has(prop)) return this.isTopLike(expr.object, scope, depth + 1);
        return false;
      }
      case 'LogicalExpression':
        return this.isTopLike(expr.left, scope, depth + 1) || this.isTopLike(expr.right, scope, depth + 1);
      case 'ConditionalExpression':
        return this.isTopLike(expr.consequent, scope, depth + 1) || this.isTopLike(expr.alternate, scope, depth + 1);
      default:
        return false;
    }
  }

  private isNamedGlobal(node: Expression | Node | null | undefined, name: string, scope: Scope, depth: number, viaDocument = false): boolean {
    if (!node || depth > 8) return false;
    const expr = this.unwrap(node as Expression);
    if (!expr) return false;
    if (expr.type === 'Identifier') {
      const r = this.resolve(expr.name, scope);
      if (r.kind === 'global') return expr.name === name;
      if (r.kind === 'alias') return this.isNamedGlobal(r.init, name, r.scope, depth + 1, viaDocument);
      return false;
    }
    if (expr.type === 'MemberExpression' && expr.object.type !== 'Super') {
      if (this.propName(expr, scope) !== name) return false;
      return (
        this.isGlobalObject(expr.object, scope, depth + 1) ||
        this.isTopLike(expr.object, scope, depth + 1) ||
        (viaDocument && this.isDocument(expr.object, scope, depth + 1))
      );
    }
    if (expr.type === 'LogicalExpression') {
      return this.isNamedGlobal(expr.left, name, scope, depth + 1, viaDocument) || this.isNamedGlobal(expr.right, name, scope, depth + 1, viaDocument);
    }
    return false;
  }

  private isDocument(node: Expression | Node | null | undefined, scope: Scope, depth = 0): boolean {
    if (!node || depth > 8) return false;
    const expr = this.unwrap(node as Expression);
    if (expr?.type === 'MemberExpression' && expr.object.type !== 'Super' && this.propName(expr, scope) === 'ownerDocument') return true;
    return this.isNamedGlobal(expr, 'document', scope, depth);
  }

  private isLocation(node: Expression | Node | null | undefined, scope: Scope, depth = 0): boolean {
    return this.isNamedGlobal(node, 'location', scope, depth, true);
  }

  private isGlobalCallee(callee: Expression | Node, name: string, scope: Scope): boolean {
    const expr = this.unwrap(callee as Expression);
    if (!expr) return false;
    if (expr.type === 'Identifier') {
      const r = this.resolve(expr.name, scope);
      if (r.kind === 'global') return expr.name === name;
      if (r.kind === 'alias') return this.isGlobalCallee(r.init, name, r.scope);
      return false;
    }
    if (expr.type === 'MemberExpression' && expr.object.type !== 'Super') {
      return this.propName(expr, scope) === name && this.isGlobalObject(expr.object, scope);
    }
    return false;
  }

  /** 静态折叠出字符串（字面量、模板、`+` 拼接、const 常量、join / concat / fromCharCode / atob 等）。 */
  private fold(node: Expression | Node | null | undefined, scope: Scope, depth = 0): Value | null {
    if (!node || depth > 12) return null;
    const expr = node as AnyNode;
    const limit = (value: Value | null): Value | null => (typeof value === 'string' && value.length > 4096 ? null : value);
    switch (expr.type) {
      case 'Literal':
        if (typeof expr.value === 'string' || typeof expr.value === 'number') return expr.value;
        if (typeof expr.value === 'boolean' || expr.value === null) return String(expr.value);
        return null;
      case 'TemplateLiteral': {
        let out = expr.quasis[0]?.value.cooked ?? '';
        for (let i = 0; i < expr.expressions.length; i += 1) {
          const part = this.fold(expr.expressions[i], scope, depth + 1);
          if (part === null) return null;
          out += String(part) + (expr.quasis[i + 1]?.value.cooked ?? '');
        }
        return limit(out);
      }
      case 'BinaryExpression': {
        if (expr.operator !== '+') return null;
        const left = this.fold(expr.left, scope, depth + 1);
        const right = this.fold(expr.right, scope, depth + 1);
        if (left === null || right === null) return null;
        if (typeof left === 'number' && typeof right === 'number') return left + right;
        return limit(String(left) + String(right));
      }
      case 'Identifier': {
        const binding = scope.lookup(expr.name);
        if (binding?.kind === 'const' && binding.init) return this.fold(binding.init, binding.scope, depth + 1);
        return null;
      }
      case 'ParenthesizedExpression':
      case 'ChainExpression':
        return this.fold(expr.expression, scope, depth + 1);
      case 'SequenceExpression':
        return this.fold(expr.expressions[expr.expressions.length - 1], scope, depth + 1);
      case 'CallExpression':
        return limit(this.foldCall(expr, scope, depth));
      default:
        return null;
    }
  }

  private foldCall(expr: CallExpression, scope: Scope, depth: number): Value | null {
    const args: (Value | null)[] = expr.arguments.map((arg) => (arg.type === 'SpreadElement' ? null : this.fold(arg, scope, depth + 1)));
    if (args.some((arg) => arg === null)) return null;
    const values = args as Value[];
    const callee = expr.callee;
    if (callee.type === 'MemberExpression' && callee.object.type !== 'Super') {
      const prop = this.propName(callee, scope);
      const object = callee.object;
      if (prop === 'join' && object.type === 'ArrayExpression') {
        const parts: string[] = [];
        for (const element of object.elements) {
          if (element === null) {
            parts.push('');
            continue;
          }
          const part = element.type === 'SpreadElement' ? null : this.fold(element, scope, depth + 1);
          if (part === null) return null;
          parts.push(String(part));
        }
        return parts.join(values.length > 0 ? String(values[0]) : ',');
      }
      if (prop === 'fromCharCode' && object.type === 'Identifier' && object.name === 'String' && !scope.lookup('String')) {
        if (!values.every((value) => typeof value === 'number')) return null;
        try {
          return String.fromCharCode(...(values as number[]));
        } catch {
          return null;
        }
      }
      const base = this.fold(object, scope, depth + 1);
      if (base === null || typeof base !== 'string') return null;
      if (prop === 'concat') return base + values.map(String).join('');
      if (values.length === 0) {
        if (prop === 'toLowerCase') return base.toLowerCase();
        if (prop === 'toUpperCase') return base.toUpperCase();
        if (prop === 'trim') return base.trim();
      }
      return null;
    }
    if (callee.type === 'Identifier' && !scope.lookup(callee.name) && values.length === 1 && typeof values[0] === 'string') {
      const input = values[0];
      try {
        if (callee.name === 'atob') return globalThis.atob(input);
        if (callee.name === 'decodeURIComponent') return decodeURIComponent(input);
        if (callee.name === 'decodeURI') return decodeURI(input);
        if (callee.name === 'unescape') return unescape(input);
      } catch {
        return null;
      }
    }
    return null;
  }

  /** 是否可能是字符串（用于 setTimeout("...")、constructor("...")）。 */
  private isStringLike(node: Expression | SpreadElement | null | undefined, scope: Scope, depth = 0): boolean {
    if (!node || node.type === 'SpreadElement' || depth > 8) return false;
    if (node.type === 'Literal') return typeof node.value === 'string';
    if (node.type === 'TemplateLiteral') return true;
    if (node.type === 'BinaryExpression' && node.operator === '+') {
      return this.isStringLike(node.left as Expression, scope, depth + 1) || this.isStringLike(node.right, scope, depth + 1);
    }
    if (node.type === 'Identifier') {
      const binding = scope.lookup(node.name);
      return binding?.kind === 'const' && binding.init !== null && this.isStringLike(binding.init, binding.scope, depth + 1);
    }
    return typeof this.fold(node, scope) === 'string';
  }

  /** 表达式的静态前缀（`'https://x/' + id` → `https://x/`）。 */
  private staticPrefix(node: Expression | null | undefined, scope: Scope, depth = 0): string | null {
    if (!node || depth > 8) return null;
    const full = this.fold(node, scope);
    if (full !== null) return String(full);
    if (node.type === 'TemplateLiteral') return node.quasis[0]?.value.cooked ?? null;
    if (node.type === 'BinaryExpression' && node.operator === '+') {
      const left = this.fold(node.left as Expression, scope);
      if (left !== null) return String(left) + (this.staticPrefix(node.right, scope, depth + 1) ?? '');
      return this.staticPrefix(node.left as Expression, scope, depth + 1);
    }
    if (node.type === 'Identifier') {
      const binding = scope.lookup(node.name);
      if (binding?.kind === 'const' && binding.init) return this.staticPrefix(binding.init, binding.scope, depth + 1);
    }
    return null;
  }

  /** 注入点里拼出的静态 HTML：字面量部分原样拼接，无法确定的部分用 DYNAMIC_PLACEHOLDER 占位。 */
  private staticHtml(node: Expression | SpreadElement | null | undefined, scope: Scope, depth = 0): string {
    const dynamic = DYNAMIC_PLACEHOLDER;
    if (!node || node.type === 'SpreadElement' || depth > 12) return dynamic;
    const full = this.fold(node, scope);
    if (full !== null) return String(full);
    switch (node.type) {
      case 'TemplateLiteral': {
        let out = '';
        node.quasis.forEach((quasi, i) => {
          out += quasi.value.cooked ?? quasi.value.raw;
          const expr = node.expressions[i];
          if (expr) out += this.staticHtml(expr, scope, depth + 1);
        });
        return out;
      }
      case 'BinaryExpression':
        return node.operator === '+' ? this.staticHtml(node.left as Expression, scope, depth + 1) + this.staticHtml(node.right, scope, depth + 1) : dynamic;
      case 'ConditionalExpression':
        return `${this.staticHtml(node.consequent, scope, depth + 1)} ${this.staticHtml(node.alternate, scope, depth + 1)}`;
      case 'LogicalExpression':
        return `${this.staticHtml(node.left, scope, depth + 1)} ${this.staticHtml(node.right, scope, depth + 1)}`;
      case 'Identifier': {
        const binding = scope.lookup(node.name);
        return binding?.init ? this.staticHtml(binding.init, binding.scope, depth + 1) : dynamic;
      }
      case 'CallExpression': {
        // [...].join('') / items.map(x => `...`).join('')
        const callee = node.callee;
        if (callee.type === 'MemberExpression' && callee.object.type !== 'Super' && this.propName(callee, scope) === 'join') {
          const object = callee.object;
          if (object.type === 'ArrayExpression') return object.elements.map((element) => this.staticHtml(element, scope, depth + 1)).join(' ');
          if (object.type === 'CallExpression') return this.staticHtml(object, scope, depth + 1);
        }
        if (callee.type === 'MemberExpression' && callee.object.type !== 'Super' && this.propName(callee, scope) === 'map') {
          const fn = node.arguments[0];
          if (fn && (fn.type === 'ArrowFunctionExpression' || fn.type === 'FunctionExpression')) {
            if (fn.body.type !== 'BlockStatement') return this.staticHtml(fn.body, scope, depth + 1);
            const ret = blockBody(fn.body).find((statement) => statement.type === 'ReturnStatement');
            if (ret?.type === 'ReturnStatement') return this.staticHtml(ret.argument, scope, depth + 1);
          }
        }
        return dynamic;
      }
      default:
        return dynamic;
    }
  }

  private checkLink(arg: Expression | SpreadElement | undefined, label: string, node: Node, scope: Scope): void {
    if (!arg || arg.type === 'SpreadElement') return;
    const full = this.fold(arg, scope);
    const report = (shown: string) =>
      this.a.issues.add(
        'INSECURE_OPEN_LINK',
        this.a.file,
        this.lineOf(node),
        `${label} 的地址 “${clip(shown)}” 不是 https: 地址`,
        HINTS.insecureLink,
      );
    if (full !== null) {
      if (!isHttpsUrl(String(full))) report(String(full));
      return;
    }
    const prefix = this.staticPrefix(arg, scope);
    if (prefix === null) return;
    const trimmed = prefix.replace(/^[\u0000-\u0020]+/, '');
    const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed)?.[1];
    if (scheme !== undefined) {
      if (scheme.toLowerCase() !== 'https') report(`${prefix}…`);
    } else if (trimmed.startsWith('//') || trimmed.startsWith('/') || trimmed.startsWith('.')) {
      report(`${prefix}…`);
    }
  }

  // ----- 字符串 -----------------------------------------------------------

  private stringPiece(value: string, node: Node): void {
    if (value === '') return;
    const a = this.a;
    addCjkChars(value, a.scriptChars);
    const lower = value.toLowerCase();
    if (lower.includes('prefers-reduced-motion')) a.scriptReducedMotionCheck = true;
    if (lower.includes('@font-face')) this.fontFace(node, '的字符串里写了 @font-face');
    if (/data:\s*(?:font\/|application\/(?:x-)?font)/.test(lower)) this.fontFace(node, '的字符串里内联了字体 data: URI');
    a.noteLooseAssetText(value);
    if (lower.includes('--nm-font-')) for (const id of findKitFontVars(value)) if (a.kit.byId.has(id)) a.useFont(id, this.lineOf(node));
    for (const font of a.kit.findFamiliesIn(value)) a.useFont(font.id, this.lineOf(node));
    if (this.exemptUrl > 0 || !(lower.includes('http://') || lower.includes('https://'))) return;
    for (const match of value.matchAll(/https?:\/\/[^\s"'`<>()\\]*/gi)) {
      const url = match[0];
      if (XML_NAMESPACES.has(url)) continue;
      const before = value.slice(Math.max(0, (match.index ?? 0) - 24), match.index ?? 0);
      if (/data-nm-href\s*=\s*["']?$/i.test(before)) continue;
      a.issues.add(
        'EXTERNAL_URL_IN_SCRIPT',
        a.file,
        this.lineOf(node),
        `${this.source.where} 的字符串里有外部地址 “${clip(url)}”`,
        HINTS.externalUrlInScript,
        url,
      );
      return;
    }
  }

  // ----- 访问者 -----------------------------------------------------------

  private visit(node: AnyNode | null | undefined, scope: Scope): void {
    if (!node) return;
    switch (node.type) {
      case 'ExpressionStatement':
        this.visit(node.expression, scope);
        return;
      case 'BlockStatement': {
        const inner = new Scope(scope);
        const body = blockBody(node);
        declareLexical(body, inner);
        for (const statement of body) this.visit(statement, inner);
        return;
      }
      case 'StaticBlock': {
        const inner = new Scope(scope);
        declareLexical(node.body, inner);
        const saved = this.thisIsGlobal;
        this.thisIsGlobal = false;
        for (const statement of node.body) this.visit(statement, inner);
        this.thisIsGlobal = saved;
        return;
      }
      case 'EmptyStatement':
      case 'DebuggerStatement':
      case 'BreakStatement':
      case 'ContinueStatement':
      case 'Super':
      case 'ThisExpression':
      case 'MetaProperty':
      case 'PrivateIdentifier':
        return;
      case 'WithStatement':
        this.visit(node.object, scope);
        this.visit(node.body, scope);
        return;
      case 'ReturnStatement':
      case 'ThrowStatement':
        this.visit(node.argument, scope);
        return;
      case 'LabeledStatement':
        this.visit(node.body, scope);
        return;
      case 'IfStatement':
      case 'ConditionalExpression':
        this.visit(node.test, scope);
        this.visit(node.consequent, scope);
        this.visit(node.alternate, scope);
        return;
      case 'SwitchStatement': {
        this.visit(node.discriminant, scope);
        const inner = new Scope(scope);
        declareLexical(
          node.cases.flatMap((switchCase) => switchCase.consequent),
          inner,
        );
        for (const switchCase of node.cases) {
          this.visit(switchCase.test, inner);
          for (const statement of switchCase.consequent) this.visit(statement, inner);
        }
        return;
      }
      case 'TryStatement':
        this.visit(node.block, scope);
        if (node.handler) {
          const inner = new Scope(scope);
          forEachPatternIdentifier(node.handler.param, (id) => inner.declare(id.name, 'catch'));
          if (node.handler.param) this.pattern(node.handler.param, inner, 'bind');
          this.visit(node.handler.body, inner);
        }
        this.visit(node.finalizer, scope);
        return;
      case 'WhileStatement':
      case 'DoWhileStatement':
        this.visit(node.test, scope);
        this.visit(node.body, scope);
        return;
      case 'ForStatement': {
        const inner = new Scope(scope);
        if (node.init?.type === 'VariableDeclaration' && node.init.kind !== 'var') declareLexical([node.init], inner);
        this.visit(node.init, inner);
        this.visit(node.test, inner);
        this.visit(node.update, inner);
        this.visit(node.body, inner);
        return;
      }
      case 'ForInStatement':
      case 'ForOfStatement': {
        const inner = new Scope(scope);
        if (node.left.type === 'VariableDeclaration') {
          if (node.left.kind !== 'var') declareLexical([node.left], inner);
          this.visit(node.left, inner);
        } else {
          this.pattern(node.left, inner, 'assign');
        }
        this.visit(node.right, inner);
        this.visit(node.body, inner);
        return;
      }
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        this.fn(node, scope);
        return;
      case 'VariableDeclaration':
        for (const decl of node.declarations) {
          this.pattern(decl.id, scope, 'bind', decl.init ?? undefined);
          this.visit(decl.init, scope);
        }
        return;
      case 'ClassDeclaration':
      case 'ClassExpression':
        this.cls(node, scope);
        return;
      case 'ImportDeclaration':
        this.moduleSource(node.source);
        return;
      case 'ExportNamedDeclaration':
        this.visit(node.declaration, scope);
        if (node.source) this.moduleSource(node.source);
        return;
      case 'ExportDefaultDeclaration':
        this.visit(node.declaration, scope);
        return;
      case 'ExportAllDeclaration':
        this.moduleSource(node.source);
        return;
      case 'Identifier':
        this.reference(node, scope);
        return;
      case 'Literal':
        if (typeof node.value === 'string') this.stringPiece(node.value, node);
        return;
      case 'TemplateLiteral':
        for (const quasi of node.quasis) this.stringPiece(quasi.value.cooked ?? quasi.value.raw, quasi);
        for (const expr of node.expressions) this.visit(expr, scope);
        return;
      case 'TaggedTemplateExpression':
        this.visit(node.tag, scope);
        this.visit(node.quasi, scope);
        return;
      case 'ArrayExpression':
        for (const element of node.elements) this.visit(element, scope);
        return;
      case 'ObjectExpression':
        for (const prop of node.properties) {
          if (prop.type === 'SpreadElement') {
            this.visit(prop.argument, scope);
          } else {
            if (prop.computed) this.visit(prop.key, scope);
            this.visit(prop.value, scope);
          }
        }
        return;
      case 'SpreadElement':
      case 'UnaryExpression':
      case 'YieldExpression':
      case 'AwaitExpression':
        this.visit(node.argument, scope);
        return;
      case 'UpdateExpression':
        this.pattern(node.argument as Pattern, scope, 'assign');
        return;
      case 'BinaryExpression':
      case 'LogicalExpression':
        this.visit(node.left, scope);
        this.visit(node.right, scope);
        return;
      case 'AssignmentExpression':
        this.assignment(node, scope);
        return;
      case 'CallExpression':
        this.call(node, scope);
        return;
      case 'NewExpression':
        this.newExpression(node, scope);
        return;
      case 'SequenceExpression':
        for (const expr of node.expressions) this.visit(expr, scope);
        return;
      case 'MemberExpression':
        this.member(node, scope);
        return;
      case 'ChainExpression':
      case 'ParenthesizedExpression':
        this.visit(node.expression, scope);
        return;
      case 'ImportExpression':
        this.api('动态 import()', 'network', node);
        this.visit(node.source, scope);
        this.visit(node.options, scope);
        return;
      case 'ObjectPattern':
      case 'ArrayPattern':
      case 'AssignmentPattern':
      case 'RestElement':
        this.pattern(node, scope, 'assign');
        return;
      default:
        this.generic(node, scope);
        return;
    }
  }

  /** 未知节点（新语法）：遍历所有子节点，保证不漏检。 */
  private generic(node: AnyNode, scope: Scope): void {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'range' || key === 'type') continue;
      const children = Array.isArray(value) ? value : [value];
      for (const child of children) {
        if (child && typeof child === 'object' && typeof (child as { type?: unknown }).type === 'string') this.visit(child as AnyNode, scope);
      }
    }
  }

  private fn(node: FunctionNode & { type: string }, scope: Scope): void {
    const inner = new Scope(scope);
    if (node.type === 'FunctionExpression' && node.id) inner.declare(node.id.name, 'function');
    for (const param of node.params) forEachPatternIdentifier(param, (id) => inner.declare(id.name, 'param'));
    const body = node.body;
    if (body.type === 'BlockStatement') {
      hoistVars(blockBody(body), inner);
      declareLexical(blockBody(body), inner);
    }
    const saved = this.thisIsGlobal;
    if (node.type !== 'ArrowFunctionExpression') this.thisIsGlobal = false;
    for (const param of node.params) this.pattern(param, inner, 'bind');
    if (body.type === 'BlockStatement') for (const statement of blockBody(body)) this.visit(statement, inner);
    else this.visit(body, inner);
    this.thisIsGlobal = saved;
  }

  private cls(node: Class & { type: string }, scope: Scope): void {
    let inner = scope;
    if (node.type === 'ClassExpression' && node.id) {
      inner = new Scope(scope);
      inner.declare(node.id.name, 'class');
    }
    this.visit(node.superClass, scope);
    const saved = this.thisIsGlobal;
    this.thisIsGlobal = false;
    for (const member of node.body.body) {
      if (member.type === 'MethodDefinition') {
        if (member.computed) this.visit(member.key, inner);
        this.fn(member.value, inner);
      } else if (member.type === 'PropertyDefinition') {
        if (member.computed) this.visit(member.key, inner);
        this.visit(member.value, inner);
      } else {
        this.visit(member, inner);
      }
    }
    this.thisIsGlobal = saved;
  }

  private pattern(node: Pattern, scope: Scope, mode: 'bind' | 'assign', source?: Expression): void {
    switch (node.type) {
      case 'Identifier':
        if (mode === 'assign') this.reference(node, scope);
        return;
      case 'MemberExpression':
        this.member(node, scope);
        return;
      case 'ObjectPattern':
        this.destructure(node, scope, source);
        for (const prop of node.properties) {
          if (prop.type === 'RestElement') {
            this.pattern(prop.argument, scope, mode);
          } else {
            if (prop.computed) this.visit(prop.key, scope);
            this.pattern(prop.value, scope, mode);
          }
        }
        return;
      case 'ArrayPattern':
        for (const element of node.elements) if (element) this.pattern(element, scope, mode);
        return;
      case 'AssignmentPattern':
        this.pattern(node.left, scope, mode, source);
        this.visit(node.right, scope);
        return;
      case 'RestElement':
        this.pattern(node.argument, scope, mode);
        return;
      default:
        return;
    }
  }

  /** `const { localStorage } = window`、`const { fetch: f } = self` 等解构取值。 */
  private destructure(node: ObjectPattern, scope: Scope, source: Expression | undefined): void {
    for (const prop of node.properties) {
      if (prop.type !== 'Property') continue;
      let key: string | null = null;
      if (prop.computed) {
        const value = this.fold(prop.key, scope);
        key = value === null ? null : String(value);
      } else if (prop.key.type === 'Identifier') {
        key = prop.key.name;
      } else if (prop.key.type === 'Literal') {
        key = String(prop.key.value);
      }
      if (key === null) continue;
      const distinctive = DISTINCTIVE_APIS[key];
      if (distinctive) this.api(key, distinctive, prop);
      if (!source) continue;
      const globalMember = GLOBAL_MEMBER_APIS[key];
      if (globalMember && this.isGlobalObject(source, scope)) this.api(globalMember.label, globalMember.category, prop);
      if (key === 'cookie' && this.isDocument(source, scope)) this.api('document.cookie', 'storage', prop);
      if ((key === 'assign' || key === 'replace') && this.isLocation(source, scope)) this.api(`location.${key}`, 'navigation', prop);
      if (key === 'location' && this.isTopLike(source, scope)) this.api('top.location', 'navigation', prop);
    }
  }

  private reference(node: Identifier, scope: Scope): void {
    const name = node.name;
    if (scope.lookup(name)) return;
    const distinctive = DISTINCTIVE_APIS[name];
    if (distinctive) {
      this.api(name, distinctive, node);
      return;
    }
    const globalApi = GLOBAL_IDENTIFIER_APIS[name];
    if (globalApi) {
      this.api(name, globalApi, node);
      return;
    }
    if (name === 'FontFace') this.fontFace(node, '用 FontFace 加载字体');
    else if (RAF_NAMES.has(name)) this.a.noteScriptMotion(this.lineOf(node), 'requestAnimationFrame');
  }

  private member(node: MemberExpression, scope: Scope): void {
    if (node.object.type !== 'Super') this.visit(node.object, scope);
    if (node.computed) this.visit(node.property, scope);
    const prop = this.propName(node, scope);
    if (prop === null) return;
    const distinctive = DISTINCTIVE_APIS[prop];
    if (distinctive) this.api(prop, distinctive, node);
    if (prop === 'reducedMotion') this.a.scriptReducedMotionCheck = true;
    if (node.object.type === 'Super') return;
    const object = node.object;
    const globalMember = GLOBAL_MEMBER_APIS[prop];
    if (globalMember && this.isGlobalObject(object, scope)) this.api(globalMember.label, globalMember.category, node);
    if (prop === 'FontFace' && this.isGlobalObject(object, scope)) this.fontFace(node, '用 FontFace 加载字体');
    if (RAF_NAMES.has(prop) && this.isGlobalObject(object, scope)) this.a.noteScriptMotion(this.lineOf(node), 'requestAnimationFrame');
    if (prop === 'location' && this.isTopLike(object, scope)) this.api(`${this.topLabel(object)}.location`, 'navigation', node);
    if (prop === 'cookie' && this.isDocument(object, scope)) this.api('document.cookie', 'storage', node);
    if ((prop === 'assign' || prop === 'replace') && this.isLocation(object, scope)) this.api(`location.${prop}`, 'navigation', node);
    if (prop === 'navigate' && this.isNamedGlobal(object, 'navigation', scope, 0)) this.api('navigation.navigate', 'navigation', node);
  }

  private topLabel(node: Expression): string {
    const expr = this.unwrap(node);
    if (expr?.type === 'Identifier' && TOP_ALIASES.has(expr.name)) return expr.name;
    if (expr?.type === 'MemberExpression' && !expr.computed && expr.property.type === 'Identifier' && TOP_ALIASES.has(expr.property.name)) {
      return expr.property.name;
    }
    return 'top';
  }

  private assignment(node: AssignmentExpression, scope: Scope): void {
    const left = node.left;
    if (left.type === 'ObjectPattern' || left.type === 'ArrayPattern') this.pattern(left, scope, 'assign', node.right);
    else if (left.type === 'Identifier') this.reference(left, scope);
    else this.visit(left, scope);

    let linkLabel: string | null = null;
    let sinkProp: string | null = null;
    if (left.type === 'MemberExpression' && left.object.type !== 'Super') {
      const prop = this.propName(left, scope);
      const object = left.object;
      if (prop === 'nmHref' && object.type === 'MemberExpression' && object.object.type !== 'Super' && this.propName(object, scope) === 'dataset') {
        linkLabel = 'dataset.nmHref';
      }
      if (prop !== null && HTML_SINK_PROPERTIES.has(prop)) sinkProp = prop;
    }

    if (linkLabel) this.exemptUrl += 1;
    this.visit(node.right, scope);
    if (linkLabel) {
      this.exemptUrl -= 1;
      this.checkLink(node.right, linkLabel, node, scope);
    }
    if (sinkProp) this.htmlSink(node.right, node, sinkProp, scope);

    if (left.type === 'Identifier' || left.type === 'MemberExpression') {
      if (this.isLocation(left, scope)) {
        this.api('location =', 'navigation', node);
      } else if (left.type === 'MemberExpression' && left.object.type !== 'Super' && this.isLocation(left.object, scope)) {
        const prop = this.propName(left, scope);
        if (prop !== 'hash') this.api(`location.${prop ?? '[…]'} =`, 'navigation', node);
      }
    }
  }

  private call(node: CallExpression, scope: Scope): void {
    const callee = node.callee;
    const member = callee.type === 'MemberExpression' && callee.object.type !== 'Super' ? callee : null;
    const calleeProp = member ? this.propName(member, scope) : null;
    const isOpenLink = (callee.type === 'Identifier' && callee.name === 'openLink') || calleeProp === 'openLink';
    const firstArg = node.arguments[0];
    const firstValue = firstArg && firstArg.type !== 'SpreadElement' ? this.fold(firstArg, scope) : null;
    const attrName = calleeProp === 'setAttribute' && firstValue !== null ? String(firstValue).toLowerCase() : null;
    const isSetNmHref = attrName === 'data-nm-href';

    if (callee.type !== 'Super') this.visit(callee, scope);
    node.arguments.forEach((arg, index) => {
      const exempt = (isOpenLink && index === 0) || (isSetNmHref && index === 1);
      if (exempt) this.exemptUrl += 1;
      this.visit(arg, scope);
      if (exempt) this.exemptUrl -= 1;
    });

    if (isOpenLink) this.checkLink(firstArg, 'nowme.openLink', node, scope);
    if (isSetNmHref) this.checkLink(node.arguments[1], 'data-nm-href', node, scope);
    if (callee.type === 'Super') return;

    if (this.isGlobalCallee(callee, 'Function', scope)) this.api('Function()', 'eval', node);
    if (this.isGlobalCallee(callee, 'open', scope)) this.api('window.open', 'navigation', node);
    for (const timer of TIMER_NAMES) {
      if (!this.isGlobalCallee(callee, timer, scope)) continue;
      if (this.isStringLike(firstArg, scope)) this.api(`${timer}("...")`, 'eval', node);
      if (timer === 'setInterval' && this.a.intervalLine === null) this.a.intervalLine = this.lineOf(node);
    }
    if (calleeProp === 'constructor' && this.isStringLike(firstArg, scope)) this.api('constructor("...")（等同 new Function）', 'eval', node);
    if (calleeProp === 'getContext' && this.a.canvasLine === null) this.a.canvasLine = this.lineOf(node);
    if (calleeProp === 'animate') this.a.noteScriptMotion(this.lineOf(node), '.animate()');

    // Object.assign(location, …) / Reflect.set(location, …)
    if (member && (calleeProp === 'assign' || calleeProp === 'set' || calleeProp === 'defineProperty') && this.isLocation(firstArg ?? null, scope)) {
      this.api('修改 location', 'navigation', node);
    }

    // 动态创建禁止的元素
    if (calleeProp === 'createElement' || calleeProp === 'createElementNS') {
      const tagArg = calleeProp === 'createElement' ? firstArg : node.arguments[1];
      const tag = tagArg && tagArg.type !== 'SpreadElement' ? this.fold(tagArg, scope) : null;
      if (tag !== null && FORBIDDEN_CREATED_ELEMENTS.has(String(tag).trim().toLowerCase())) {
        const name = String(tag).trim().toLowerCase();
        this.a.issues.add(
          'FORBIDDEN_ELEMENT',
          this.a.file,
          this.lineOf(node),
          `${this.source.where} 动态创建了 <${name}>`,
          forbiddenElementHint(name),
        );
      }
    }

    // setAttribute('onclick', '...')：字符串会被当作事件处理代码
    if (attrName !== null && /^on[a-z]+$/.test(attrName)) {
      const code = node.arguments[1];
      const text = code && code.type !== 'SpreadElement' ? this.fold(code, scope) : null;
      if (text !== null) this.queue.push({ code: String(text), line: this.lineOf(node), kind: 'handler', where: `setAttribute('${attrName}') 的代码` });
    }

    // HTML 注入点
    if (calleeProp === 'insertAdjacentHTML') this.htmlSink(node.arguments[1], node, 'insertAdjacentHTML', scope);
    if (calleeProp === 'createContextualFragment' || calleeProp === 'setHTMLUnsafe' || calleeProp === 'parseHTMLUnsafe') {
      this.htmlSink(firstArg, node, calleeProp, scope);
    }
    if ((calleeProp === 'write' || calleeProp === 'writeln') && member && this.isDocument(member.object, scope)) {
      for (const arg of node.arguments) this.htmlSink(arg, node, `document.${calleeProp}`, scope);
    }
  }

  private newExpression(node: NewExpression, scope: Scope): void {
    this.visit(node.callee, scope);
    for (const arg of node.arguments) this.visit(arg, scope);
    const callee = node.callee;
    if (this.isGlobalCallee(callee, 'Function', scope)) this.api('new Function', 'eval', node);
    if (this.isGlobalCallee(callee, 'Worker', scope)) this.api('new Worker', 'worker', node);
    if (this.isGlobalCallee(callee, 'SharedWorker', scope)) this.api('new SharedWorker', 'worker', node);
    if (this.isGlobalCallee(callee, 'FontFace', scope)) this.fontFace(node, '用 FontFace 加载字体');
    if (this.isGlobalCallee(callee, 'KeyframeEffect', scope) || this.isGlobalCallee(callee, 'Animation', scope)) {
      this.a.noteScriptMotion(this.lineOf(node), 'Web Animations');
    }
  }

  private htmlSink(arg: Expression | SpreadElement | undefined, node: Node, where: string, scope: Scope): void {
    if (!arg) return;
    const html = this.staticHtml(arg, scope);
    if (!html.includes('<')) return;
    this.sink(html, this.lineOf(node), `${this.source.where} 写入 ${where} 的 HTML`);
  }

  /** 模块脚本的 import / export from：只允许 Kit。 */
  private moduleSource(source: Literal): void {
    if (typeof source.value !== 'string') return;
    this.a.refs.push({ raw: source.value, line: this.lineOf(source), where: `${this.source.where} 的 import`, source: 'js-import' });
  }
}
