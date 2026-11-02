// src/core/xml.mjs
// 极简 XML 解析器：只求解析 OOXML 这类「格式良好、无 DTD、无外部实体」的文档。
// 不做 namespace 解析（标签名原样保留，如 "w:p"、"w14:paraId"），因为 OOXML
// 的语义完全靠前缀区分，保留前缀反而更直观。
//
// 输出节点：{ name, attrs: {k:v}, children: [node], text: string }
//   - text 只存该节点的「直接文本」（子节点文本不向上合并），需要全文时用 textOf()。

const NAME_ATTR_RE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

const ENTITY_MAP = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** 解码 XML 实体（命名实体 + 十进制/十六进制字符引用）。 */
export function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code)) return m;
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return Object.prototype.hasOwnProperty.call(ENTITY_MAP, body) ? ENTITY_MAP[body] : m;
  });
}

function findTagEnd(text, from) {
  // 从 '<' 之后找 '>'，跳过属性值里的 '>'
  let quote = 0;
  for (let i = from; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (quote) {
      if (c === quote) quote = 0;
      continue;
    }
    if (c === 34 /* " */ || c === 39 /* ' */) { quote = c; continue; }
    if (c === 62 /* > */) return i;
  }
  return -1;
}

function makeNode(name, attrs) {
  return { name, attrs, children: [], text: '' };
}

/**
 * 解析 XML 字符串。
 * @param {string} text
 * @param {{htmlEntities?: boolean}} [opts]
 * @returns {{name:'#document', children: any[], text: string}}
 */
export function parseXml(text, opts = {}) {
  const root = makeNode('#document', {});
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let i = 0;
  let sawElement = 0;

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      const tail = text.slice(i);
      if (tail) top().text += decodeEntities(tail);
      break;
    }
    if (lt > i) {
      const chunk = text.slice(i, lt);
      if (chunk.trim()) top().text += decodeEntities(chunk);
      else if (chunk) top().text += chunk; // 保留空白（w:t xml:space="preserve" 需要）
    }

    if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt + 4);
      i = e < 0 ? text.length : e + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const e = text.indexOf(']]>', lt + 9);
      top().text += e < 0 ? text.slice(lt + 9) : text.slice(lt + 9, e);
      i = e < 0 ? text.length : e + 3;
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const e = text.indexOf('?>', lt + 2);
      i = e < 0 ? text.length : e + 2;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      const e = text.indexOf('>', lt + 2);
      i = e < 0 ? text.length : e + 1;
      continue;
    }

    const gt = findTagEnd(text, lt + 1);
    if (gt < 0) break;
    const raw = text.slice(lt + 1, gt);
    i = gt + 1;

    if (raw[0] === '/') {
      // 结束标签
      const name = raw.slice(1).trim();
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) { stack.length = k; break; }
      }
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const wsIdx = body.search(/[\s]/);
    const name = wsIdx < 0 ? body : body.slice(0, wsIdx);
    const attrs = {};
    if (wsIdx >= 0) {
      const rest = body.slice(wsIdx);
      NAME_ATTR_RE.lastIndex = 0;
      let m;
      while ((m = NAME_ATTR_RE.exec(rest))) {
        const v = m[3] !== undefined ? m[3] : m[4];
        attrs[m[1]] = decodeEntities(v);
      }
    }
    const node = makeNode(name, attrs);
    top().children.push(node);
    sawElement++;
    if (!selfClosing) stack.push(node);
  }

  if (!sawElement) throw new Error('xml: 未发现任何元素');
  return root;
}

/** 取节点的完整文本（深度优先，含子节点文本）。 */
export function textOf(node) {
  let out = node.text || '';
  for (const c of node.children) out += textOf(c);
  return out;
}

/** 深度优先遍历。 */
export function* walk(node) {
  yield node;
  for (const c of node.children) yield* walk(c);
}

/** 查找第一个满足条件的后代（含自身）。 */
export function find(node, pred) {
  for (const n of walk(node)) if (pred(n)) return n;
  return null;
}

/** 查找所有满足条件的后代。 */
export function findAll(node, pred) {
  const out = [];
  for (const n of walk(node)) if (pred(n)) out.push(n);
  return out;
}

/** 按标签名取直接子节点。 */
export function childrenNamed(node, name) {
  return node.children.filter((c) => c.name === name);
}

/** 按标签名取第一个直接子节点。 */
export function childNamed(node, name) {
  for (const c of node.children) if (c.name === name) return c;
  return null;
}
