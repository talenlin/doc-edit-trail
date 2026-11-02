// src/core/diff.mjs
// 结构化 diff：输入两份同类型快照，输出契约第 2/3 节的 changes[]。
//
// 设计要点（全部来自真实文档的教训）：
//   1. 单元格按「锚点」匹配，不按行号：用户插入/删除一行后，下面所有单元格的
//      ref 都会漂移。这里先用「整行内容签名」做 LCS 对齐，把行配对起来，再在
//      配对行内比单元格；对齐后仍找不到的内容才记为 added/removed。
//   2. 列插入同理：在配对行上投票检测整列偏移 k，把 A 的列映射到 B 的列。
//   3. 整块搬移（剪切粘贴）会表现为「删除一批 + 新增一批相同内容」，这里做
//      值级配对抵消，只计入 stats.movedCells，不进 changes（否则模型读到的
//      全是位移噪声）。
//   4. 只有样式索引变化（WPS 重存常把 styles.xml 整体重排）单独归为
//      style.changed，且超过阈值就聚合为一处，避免上千条噪声淹没真实改动。
//   5. 长文本只给「前缀 24 字 + 首个差异窗口 40 字 + 后缀 14 字」，并给出
//      firstDiffAt / charDelta / beforeLen / afterLen；原文 ≤1000 字时附全文。

const SUMMARY_MAX = 120;
const HEAD_CONTEXT = 24;
const WINDOW = 40;
const TAIL_CONTEXT = 14;
const FULL_TEXT_LIMIT = 1000;
const DEFAULT_CHANGE_LIMIT = 2000;

// ------------------------------------------------------------------ 文本摘要

export function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

export function commonSuffixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++;
  return i;
}

/**
 * 长文本摘要：前缀上下文 + 首个差异窗口 + 后缀上下文。
 * 文本本身不长时原样返回。
 */
export function summarizeText(text, diffAt, opts = {}) {
  const max = opts.maxLen || SUMMARY_MAX;
  const win = opts.window || WINDOW;
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  const headCtx = opts.headContext || HEAD_CONTEXT;
  const tailCtx = opts.tailContext || TAIL_CONTEXT;
  const probe = Math.max(0, Math.min(diffAt, text.length));
  let start = Math.max(0, probe - headCtx);
  let end = Math.min(text.length, probe + win + tailCtx);
  // 保证至少覆盖到差异点之后一个窗口，且整体不超过 max
  if (end - start > max) end = start + max;
  let out = text.slice(start, end);
  if (start > 0) out = `…${out}`;
  if (end < text.length) out = `${out}…`;
  return out;
}

/**
 * 组装一处文本变化的 before/after 摘要。
 * @returns {{before:string|null, after:string|null, beforeFull?:string, afterFull?:string,
 *   charDelta:number, firstDiffAt:number, beforeLen:number, afterLen:number}}
 */
export function describeTextChange(beforeRaw, afterRaw, opts = {}) {
  const before = beforeRaw == null ? '' : String(beforeRaw);
  const after = afterRaw == null ? '' : String(afterRaw);
  const firstDiffAt = commonPrefixLen(before, after);
  const result = {
    before: null,
    after: null,
    charDelta: after.length - before.length,
    firstDiffAt,
    beforeLen: before.length,
    afterLen: after.length,
  };
  if (opts.noContent) return result;
  result.before = summarizeText(before, firstDiffAt, opts);
  result.after = summarizeText(after, firstDiffAt, opts);
  if (before.length <= (opts.fullTextLimit || FULL_TEXT_LIMIT)) result.beforeFull = before;
  if (after.length <= (opts.fullTextLimit || FULL_TEXT_LIMIT)) result.afterFull = after;
  return result;
}

// ------------------------------------------------------------------ 序列对齐

/** 贪心对齐（大序列退化路径）：按 key 找 B 中最靠前且在上次匹配之后的同 key 项。 */
function greedyPairs(aKeys, bKeys, equal) {
  const pairs = [];
  let lastB = -1;
  for (let i = 0; i < aKeys.length; i++) {
    for (let j = lastB + 1; j < bKeys.length; j++) {
      if (equal(aKeys[i], bKeys[j])) {
        pairs.push([i, j]);
        lastB = j;
        break;
      }
    }
  }
  return pairs;
}

/** 字符二元组 Dice 相似度：中文改写的段落能被识别为「同一段被改写」。 */
export function textSimilarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    if (s.length === 1) set.add(s);
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return (2 * inter) / (ga.size + gb.size);
}

/**
 * 在 LCS 之外的空隙里，把「删除的一段」和「新增的一段」按相似度配对成
 * 「改写」。不配对就会出现「几十段删除 + 几十段新增」这种读数，
 * 对读者毫无信息量。
 * @param {string[]} listA 旧文本
 * @param {string[]} listB 新文本
 * @returns {Array<{a:number|null, b:number|null}>} 按顺序的配对/孤立项
 */
export function alignGapsByText(listA, listB, threshold = 0.3, simFn = textSimilarity) {
  const n = listA.length;
  const m = listB.length;
  if (!n) return listB.map((_, j) => ({ a: null, b: j }));
  if (!m) return listA.map((_, i) => ({ a: i, b: null }));
  // 打分：配对得分 = 相似度 - 阈值（只有过阈值才为正），空位 0
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Float64Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sim = simFn(listA[i - 1], listB[j - 1]);
      const pairScore = sim >= threshold ? sim - threshold : -1;
      dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1] + pairScore);
    }
  }
  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const sim = simFn(listA[i - 1], listB[j - 1]);
    const pairScore = sim >= threshold ? sim - threshold : -1;
    if (Math.abs(dp[i][j] - (dp[i - 1][j - 1] + pairScore)) < 1e-9 && pairScore > -1) {
      ops.push({ a: i - 1, b: j - 1 });
      i--;
      j--;
    } else if (dp[i][j] === dp[i - 1][j]) {
      ops.push({ a: i - 1, b: null });
      i--;
    } else {
      ops.push({ a: null, b: j - 1 });
      j--;
    }
  }
  while (i > 0) { ops.push({ a: i - 1, b: null }); i--; }
  while (j > 0) { ops.push({ a: null, b: j - 1 }); j--; }
  return ops.reverse();
}

/**
 * LCS 对齐，返回 [[iA, iB], ...]。
 * @param {any[]} aKeys
 * @param {any[]} bKeys
 * @param {(a:any,b:any)=>boolean} [eq]
 */
export function lcsPairs(aKeys, bKeys, eq) {
  const equal = eq || ((x, y) => x === y);
  const n = aKeys.length;
  const m = bKeys.length;
  if (!n || !m) return [];
  if (n * m > 4_000_000) return greedyPairs(aKeys, bKeys, equal);
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i];
    const next = dp[i + 1];
    const ai = aKeys[i];
    for (let j = m - 1; j >= 0; j--) {
      row[j] = equal(ai, bKeys[j]) ? next[j + 1] + 1 : (next[j] >= row[j + 1] ? next[j] : row[j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (equal(aKeys[i], bKeys[j])) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

// ------------------------------------------------------------------ 通用小工具

const REF_RE = /^([A-Z]+)(\d+)$/;

export function parseRef(ref) {
  const m = REF_RE.exec(ref || '');
  if (!m) return null;
  return { col: refColToIndex(m[1]), row: Number(m[2]), colLetters: m[1] };
}

export function refColToIndex(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n; // 1-based
}

function refSortKey(ref) {
  const p = parseRef(ref);
  return p ? p.row * 10000 + p.col : 0;
}

function collectCellsByRow(cells) {
  const rows = new Map();
  for (const [ref, cell] of Object.entries(cells || {})) {
    const p = parseRef(ref);
    if (!p) continue;
    if (!rows.has(p.row)) rows.set(p.row, []);
    rows.get(p.row).push({ ref, col: p.col, cell });
  }
  for (const list of rows.values()) list.sort((x, y) => x.col - y.col);
  return rows;
}

function rowSignature(rowCells) {
  if (!rowCells || !rowCells.length) return '';
  return rowCells.map((c) => `${c.col}=${c.cell.t}:${c.cell.v}`).join('\u0001');
}

function newChange(kind, anchor, extra = {}) {
  const change = { kind, anchor };
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined) change[k] = v;
  }
  if (change.styleChanged === undefined) change.styleChanged = false;
  if (change.charDelta === undefined) change.charDelta = 0;
  if (change.firstDiffAt === undefined) change.firstDiffAt = 0;
  return change;
}

/** 变更分类（report/摘要共用）：结构 / 文本 / 图表 / 其他。 */
export function classifyChange(kind) {
  if (/^(sheet\.|merge\.|row\.|pagebreak\.|slide\.(added|removed)|doc\.version)/.test(kind)) return 'structure';
  if (/^(cell\.|para\.|table\.|formula\.|shape\.|heading\.|slide\.changed)/.test(kind)) return 'text';
  if (/^(chart\.|media\.)/.test(kind)) return 'chart';
  return 'other';
}

export function countKinds(changes) {
  const counts = {};
  for (const c of changes) counts[c.kind] = (counts[c.kind] || 0) + 1;
  return counts;
}

function pushCapped(changes, change, limit) {
  if (changes.length < limit) changes.push(change);
  return changes;
}

// ================================================================== xlsx

function sheetValueSet(sheet) {
  const set = new Set();
  for (const cell of Object.values(sheet.cells || {})) {
    const v = cell.v;
    if (typeof v === 'string' && v.length >= 3) set.add(v);
  }
  return set;
}

function sheetSimilarity(a, b) {
  const sa = sheetValueSet(a);
  const sb = sheetValueSet(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  const small = sa.size <= sb.size ? sa : sb;
  const big = sa.size <= sb.size ? sb : sa;
  for (const v of small) if (big.has(v)) inter++;
  return inter / Math.max(sa.size, sb.size);
}

function describeChart(chart) {
  if (!chart) return null;
  const points = chart.series.reduce((sum, s) => sum + s.valCount, 0);
  const bits = [chart.type, `${chart.seriesCount} 系列`, `${points} 数据点`];
  if (chart.title) bits.push(`标题「${chart.title}」`);
  return bits.join(' · ');
}

function chartValues(chart) {
  return chart.series.map((s) => `${s.name || '?'}=[${(s.valPoints || []).join(',')}]`).join('; ');
}

/** 检测整列偏移：返回最可信的列偏移 k（B 列 = A 列 + k）。 */
function detectColumnShift(pairedRows) {
  const votes = new Map();
  let usable = 0;
  for (const { aCells, bCells } of pairedRows) {
    if (aCells.length < 3 || bCells.length < 3) continue;
    usable++;
    let bestK = 0;
    let bestScore = -1;
    for (let k = -4; k <= 4; k++) {
      let score = 0;
      for (const c of aCells) {
        const hit = bCells.find((x) => x.col === c.col + k && x.cell.v === c.cell.v);
        if (hit) score++;
      }
      if (score > bestScore) { bestScore = score; bestK = k; }
    }
    votes.set(bestK, (votes.get(bestK) || 0) + 1);
  }
  if (!usable) return 0;
  let modeK = 0;
  let modeCount = 0;
  for (const [k, n] of votes) {
    if (k !== 0 && n > modeCount) { modeCount = n; modeK = k; }
  }
  // 至少 2 行、且覆盖一半以上可判行，才认为是整列偏移
  if (modeCount >= 2 && modeCount >= usable / 2) return modeK;
  return 0;
}

function diffSheetCells(sheetName, sheetA, sheetB, ctx) {
  const stats = { rowsAdded: 0, rowsRemoved: 0, movedCells: 0, styleOnly: 0, columnShift: 0 };
  const rowsA = collectCellsByRow(sheetA.cells);
  const rowsB = collectCellsByRow(sheetB.cells);
  const numsA = [...rowsA.keys()].sort((x, y) => x - y);
  const numsB = [...rowsB.keys()].sort((x, y) => x - y);
  const sigA = numsA.map((r) => rowSignature(rowsA.get(r)));
  const sigB = numsB.map((r) => rowSignature(rowsB.get(r)));
  const matches = lcsPairs(sigA, sigB);

  // 1) 行对齐：匹配行 + 空隙按顺序配对
  const paired = [];
  let prevI = -1;
  let prevJ = -1;
  const flushGap = (i, j) => {
    const gapA = numsA.slice(prevI + 1, i);
    const gapB = numsB.slice(prevJ + 1, j);
    const n = Math.min(gapA.length, gapB.length);
    for (let t = 0; t < n; t++) paired.push({ a: gapA[t], b: gapB[t], matched: false });
    for (let t = n; t < gapA.length; t++) paired.push({ a: gapA[t], b: null });
    for (let t = n; t < gapB.length; t++) paired.push({ a: null, b: gapB[t] });
  };
  for (const [i, j] of matches) {
    flushGap(i, j);
    paired.push({ a: numsA[i], b: numsB[j], matched: true });
    prevI = i;
    prevJ = j;
  }
  flushGap(numsA.length, numsB.length);

  // 2) 列偏移检测（只在双行都在的配对行上投票）
  const shift = detectColumnShift(
    paired
      .filter((p) => p.a !== null && p.b !== null)
      .map((p) => ({ aCells: rowsA.get(p.a) || [], bCells: rowsB.get(p.b) || [] })),
  );
  stats.columnShift = shift;

  const removed = [];
  const added = [];
  const changed = [];
  const styleOnly = [];

  const compareCell = (aCell, bCell) => {
    const sameValue = aCell.cell.v === bCell.cell.v;
    const sameType = aCell.cell.t === bCell.cell.t;
    const sameFormula = (aCell.cell.f || '') === (bCell.cell.f || '');
    const styleChanged = aCell.cell.s !== bCell.cell.s;
    if (sameValue && sameType && sameFormula) {
      if (styleChanged) {
        stats.styleOnly++;
        styleOnly.push({ ...aCell, other: bCell });
      }
      return;
    }
    const d = describeTextChange(aCell.cell.v, bCell.cell.v, ctx);
    let kind = 'cell.changed';
    if (sameValue && sameType && !sameFormula) kind = 'formula.changed';
    changed.push(newChange(kind, `${sheetName}!${aCell.ref}`, {
      sheet: sheetName,
      cell: aCell.ref,
      before: d.before,
      after: d.after,
      beforeFull: d.beforeFull,
      afterFull: d.afterFull,
      beforeLen: d.beforeLen,
      afterLen: d.afterLen,
      styleChanged,
      charDelta: d.charDelta,
      firstDiffAt: d.firstDiffAt,
    }));
  };

  for (const pair of paired) {
    if (pair.a !== null && pair.b !== null) {
      const aCells = rowsA.get(pair.a) || [];
      const bCells = rowsB.get(pair.b) || [];
      const bByCol = new Map(bCells.map((c) => [c.col, c]));
      for (const aCell of aCells) {
        const bCell = bByCol.get(aCell.col + shift);
        if (bCell) compareCell(aCell, bCell);
        else removed.push(aCell);
      }
      for (const bCell of bCells) {
        if (!aCells.some((c) => c.col === bCell.col - shift)) added.push(bCell);
      }
    } else if (pair.a !== null) {
      const aCells = rowsA.get(pair.a) || [];
      stats.rowsRemoved++;
      for (const aCell of aCells) removed.push(aCell);
    } else {
      const bCells = rowsB.get(pair.b) || [];
      stats.rowsAdded++;
      for (const bCell of bCells) added.push(bCell);
    }
  }

  // 3) 整块搬移抵消：删除的单元格与新增的单元格值相同（≥4 字、非公式）视为搬移
  const addedByValue = new Map();
  for (const cell of added) {
    if (cell.cell.f) continue;
    const v = cell.cell.v;
    if (typeof v !== 'string' || v.length < 4) continue;
    if (!addedByValue.has(v)) addedByValue.set(v, []);
    addedByValue.get(v).push(cell);
  }
  const consumedAdded = new Set();
  const survivingRemoved = [];
  for (const cell of removed) {
    const v = cell.cell.v;
    const bucket = !cell.cell.f && typeof v === 'string' && v.length >= 4 ? addedByValue.get(v) : null;
    if (bucket && bucket.length) {
      const target = bucket.shift();
      consumedAdded.add(target.ref);
      stats.movedCells++;
      continue;
    }
    survivingRemoved.push(cell);
  }

  const content = [];
  for (const cell of changed) content.push(cell);
  for (const cell of survivingRemoved) {
    const d = describeTextChange(cell.cell.v, null, ctx);
    content.push(newChange('cell.removed', `${sheetName}!${cell.ref}`, {
      sheet: sheetName,
      cell: cell.ref,
      before: d.before,
      beforeFull: d.beforeFull,
      after: null,
      beforeLen: d.beforeLen,
      afterLen: 0,
      charDelta: d.charDelta,
      firstDiffAt: d.firstDiffAt,
    }));
  }
  for (const cell of added) {
    if (consumedAdded.has(cell.ref)) continue;
    const d = describeTextChange(null, cell.cell.v, ctx);
    content.push(newChange('cell.added', `${sheetName}!${cell.ref}`, {
      sheet: sheetName,
      cell: cell.ref,
      before: null,
      after: d.after,
      afterFull: d.afterFull,
      beforeLen: 0,
      afterLen: d.afterLen,
      charDelta: d.charDelta,
      firstDiffAt: d.firstDiffAt,
    }));
  }
  content.sort((x, y) => refSortKey(x.anchor.split('!').pop()) - refSortKey(y.anchor.split('!').pop()));

  const structural = [];
  // 4) 纯样式变化：少则逐条，多则聚合（WPS 重存会整体重排 styles.xml）
  const styleThreshold = ctx.styleNoiseThreshold ?? 10;
  if (styleOnly.length) {
    if (styleOnly.length > styleThreshold) {
      structural.push(newChange('style.changed', `${sheetName}!*`, {
        sheet: sheetName,
        before: `${styleOnly.length} 处样式索引差异`,
        after: '样式索引整体重排（通常无语义变化，已聚合）',
        beforeLen: 0,
        afterLen: 0,
      }));
    } else {
      for (const cell of styleOnly) {
        structural.push(newChange('style.changed', `${sheetName}!${cell.ref}`, {
          sheet: sheetName,
          cell: cell.ref,
          before: '样式 A',
          after: '样式 B',
          styleChanged: true,
          beforeLen: 0,
          afterLen: 0,
        }));
      }
    }
  }

  // 5) 合并单元格：数量一致时只报差异，差异多则聚合
  const mergesA = [...(sheetA.merges || [])].sort();
  const mergesB = [...(sheetB.merges || [])].sort();
  if (mergesA.join('|') !== mergesB.join('|')) {
    const setA = new Set(mergesA);
    const setB = new Set(mergesB);
    const mergeAdded = mergesB.filter((m) => !setA.has(m));
    const mergeRemoved = mergesA.filter((m) => !setB.has(m));
    if (mergeAdded.length + mergeRemoved.length <= 6) {
      for (const m of mergeRemoved) {
        structural.push(newChange('merge.changed', `${sheetName}!${m}`, {
          sheet: sheetName, before: `合并且 ${m}`, after: null, beforeLen: m.length, afterLen: 0,
        }));
      }
      for (const m of mergeAdded) {
        structural.push(newChange('merge.changed', `${sheetName}!${m}`, {
          sheet: sheetName, before: null, after: `合并且 ${m}`, beforeLen: 0, afterLen: m.length,
        }));
      }
    } else {
      // 绝大多数合并区同时增减 = 行插入/删除导致的整体位移，不是真的重新合并
      const shifted = mergeAdded.length > mergesB.length * 0.5 && mergeRemoved.length > mergesA.length * 0.5;
      structural.push(newChange('merge.changed', `${sheetName}!merges`, {
        sheet: sheetName,
        before: `${mergesA.length} 个合并区`,
        after: shifted
          ? `${mergesB.length} 个合并区（随行增删整体位移，+${mergeAdded.length}/-${mergeRemoved.length}）`
          : `${mergesB.length} 个合并区（+${mergeAdded.length}/-${mergeRemoved.length}）`,
        beforeLen: mergesA.length,
        afterLen: mergesB.length,
      }));
    }
  }

  // 6) 行高 / 隐藏行 / 分页符：这些是「删掉一节」「调整版式」的真实信号。
  //    只在两侧都存在的行上比较行高（按行对齐结果取号），避免插行导致行号漂移误报。
  const rowMetaA = sheetA.rowMeta || {};
  const rowMetaB = sheetB.rowMeta || {};
  const heightEdits = [];
  const hiddenEdits = [];
  for (const p of paired) {
    if (p.a === null || p.b === null) continue;
    const ma = rowMetaA[String(p.a)];
    const mb = rowMetaB[String(p.b)];
    const htA = ma && ma.ht !== null && ma.ht !== undefined ? ma.ht : null;
    const htB = mb && mb.ht !== null && mb.ht !== undefined ? mb.ht : null;
    const customA = ma ? Boolean(ma.customHeight) : false;
    const customB = mb ? Boolean(mb.customHeight) : false;
    if (htA !== htB || customA !== customB) heightEdits.push({ row: p.a, htA, htB });
    const hidA = ma ? Boolean(ma.hidden) : false;
    const hidB = mb ? Boolean(mb.hidden) : false;
    if (hidA !== hidB) hiddenEdits.push({ row: p.a, hidA, hidB });
  }
  if (heightEdits.length) {
    stats.rowHeights = heightEdits.length;
    if (heightEdits.length <= 10) {
      for (const e of heightEdits) {
        structural.push(newChange('row.height', `${sheetName}!row${e.row}`, {
          sheet: sheetName,
          before: e.htA === null ? '默认行高' : `行高 ${e.htA}pt`,
          after: e.htB === null ? '默认行高' : `行高 ${e.htB}pt`,
          beforeLen: 0,
          afterLen: 0,
        }));
      }
    } else {
      const first = heightEdits[0];
      structural.push(newChange('row.height', `${sheetName}!rows`, {
        sheet: sheetName,
        before: `${heightEdits.length} 行行高变化（首处第 ${first.row} 行 ${first.htA ?? '默认'}pt）`,
        after: `${first.htB ?? '默认'}pt 等`,
        beforeLen: 0,
        afterLen: 0,
      }));
    }
  }
  if (hiddenEdits.length) {
    stats.rowHidden = hiddenEdits.length;
    structural.push(newChange('row.hidden', `${sheetName}!rows`, {
      sheet: sheetName,
      before: `${hiddenEdits.length} 行隐藏状态变化：${hiddenEdits.slice(0, 6).map((e) => `第${e.row}行${e.hidA ? '隐藏' : '显示'}→${e.hidB ? '隐藏' : '显示'}`).join('、')}${hiddenEdits.length > 6 ? ' 等' : ''}`,
      after: null,
      beforeLen: 0,
      afterLen: 0,
    }));
  }

  // 6b) 整行随内容被删掉时，它的自定义行高也一并消失。只按行号对齐配对的行比不到这些，
  //     于是补一条聚合信号（整行删除场景下的 13 行行高就是这一类），避免用户以为
  //     「行高没变」——否则模型会漏掉「这一块的版式也被抹平了」。
  const removedRowMeta = [];
  const addedRowMeta = [];
  for (const p of paired) {
    if (p.b === null) {
      const ma = rowMetaA[String(p.a)];
      if (ma && (ma.ht !== null || ma.customHeight || ma.hidden)) removedRowMeta.push(p.a);
    } else if (p.a === null) {
      const mb = rowMetaB[String(p.b)];
      if (mb && (mb.ht !== null || mb.customHeight || mb.hidden)) addedRowMeta.push(p.b);
    }
  }
  if (removedRowMeta.length) {
    const rows = removedRowMeta.slice().sort((x, y) => x - y);
    stats.rowHeights = (stats.rowHeights || 0) + rows.length;
    structural.push(newChange('row.height', `${sheetName}!rows`, {
      sheet: sheetName,
      before: `第 ${rows.slice(0, 8).join('/')}${rows.length > 8 ? ` 等 ${rows.length}` : ''} 行（共 ${rows.length} 行）原为自定义行高，随整行删除一并消失`,
      after: '该批行已不存在',
      beforeLen: 0,
      afterLen: 0,
    }));
  }
  if (addedRowMeta.length) {
    stats.rowHeights = (stats.rowHeights || 0) + addedRowMeta.length;
    const rows = addedRowMeta.slice().sort((x, y) => x - y);
    structural.push(newChange('row.height', `${sheetName}!rows`, {
      sheet: sheetName,
      before: null,
      after: `新增第 ${rows.slice(0, 8).join('/')}${rows.length > 8 ? ` 等 ${rows.length}` : ''} 行（共 ${rows.length} 行），带自定义行高`,
      beforeLen: 0,
      afterLen: 0,
    }));
  }
  const rbA = sheetA.rowBreaks || [];
  const rbB = sheetB.rowBreaks || [];
  const cbA = sheetA.colBreaks || [];
  const cbB = sheetB.colBreaks || [];
  if (rbA.join(',') !== rbB.join(',') || cbA.join(',') !== cbB.join(',')) {
    structural.push(newChange('pagebreak.changed', `${sheetName}!pagebreak`, {
      sheet: sheetName,
      before: `行分页符 ${rbA.length} 个${rbA.length ? `（行 ${rbA.join('/')}）` : ''}，列分页符 ${cbA.length} 个`,
      after: `行分页符 ${rbB.length} 个${rbB.length ? `（行 ${rbB.join('/')}）` : ''}，列分页符 ${cbB.length} 个`,
      beforeLen: rbA.length + cbA.length,
      afterLen: rbB.length + cbB.length,
    }));
  }

  return { changes: content.concat(structural), stats };
}

function chartRefSig(chart) {
  return (chart.series || []).map((s) => `${s.name || '?'}|${s.catRef || ''}`).join(';');
}

/**
 * 图表匹配不能按 id：删掉一个 sheet 后 WPS 会把 chart2/chart3 重新编号（实测），
 * 按 id 比会把「同内容换了编号」误报成 3 处图表改动。顺序是：
 *   1) 指纹完全相同（内容没变，通常只是编号变了）→ 视为同一张图；
 *   2) 同 sheet + 同类型 + 系列引用签名一致 → 视为同一张图被改；
 *   3) 同 sheet + 同类型 → 兜底；
 *   4) 剩下的才算新增 / 删除。
 */
function diffCharts(changes, sheetName, chartsA, chartsB, ctx) {
  const usedA = new Set();
  const usedB = new Set();
  const pairs = [];
  const pairUp = (test) => {
    for (let j = 0; j < chartsB.length; j++) {
      if (usedB.has(j)) continue;
      for (let i = 0; i < chartsA.length; i++) {
        if (usedA.has(i)) continue;
        if (test(chartsA[i], chartsB[j])) {
          usedA.add(i);
          usedB.add(j);
          pairs.push([i, j]);
          break;
        }
      }
    }
  };
  pairUp((a, b) => a.fingerprint === b.fingerprint);
  pairUp(
    (a, b) =>
      a.type === b.type && (a.sheet || '') === (b.sheet || '') && chartRefSig(a) === chartRefSig(b),
  );
  pairUp((a, b) => a.type === b.type && (a.sheet || '') === (b.sheet || ''));

  for (const [i, j] of pairs) {
    const ca = chartsA[i];
    const cb = chartsB[j];
    const id = cb.id || cb.part;
    const movedSheet = ca.sheet !== cb.sheet;
    const chartChanged = ca.fingerprint !== cb.fingerprint;
    // 图表内容没变、但所在 drawing 的 XML 变了 = 锚点 / 尺寸 / 层级被移动
    const anchorMoved = !chartChanged && ca.drawingHash && cb.drawingHash && ca.drawingHash !== cb.drawingHash;
    if (chartChanged) {
      changes.push(newChange('chart.changed', `${cb.sheet || sheetName}!chart:${id}`, {
        sheet: cb.sheet || sheetName,
        before: describeChart(ca),
        after: `${describeChart(cb)}${movedSheet ? `（自「${ca.sheet}」移入）` : ''}`,
        beforeLen: chartValues(ca).length,
        afterLen: chartValues(cb).length,
      }));
    } else if (anchorMoved) {
      changes.push(newChange('chart.changed', `${cb.sheet || sheetName}!chart:${id}`, {
        sheet: cb.sheet || sheetName,
        before: `${describeChart(cb)}（原锚点）`,
        after: `${describeChart(cb)}（锚点/尺寸位移）`,
        beforeLen: chartValues(ca).length,
        afterLen: chartValues(cb).length,
      }));
    }
  }
  for (let j = 0; j < chartsB.length; j++) {
    if (usedB.has(j)) continue;
    const cb = chartsB[j];
    changes.push(newChange('chart.changed', `${cb.sheet || sheetName}!chart:${cb.id || cb.part}`, {
      sheet: cb.sheet || sheetName,
      before: null,
      after: `新增${describeChart(cb)}`,
      beforeLen: 0,
      afterLen: 0,
    }));
  }
  for (let i = 0; i < chartsA.length; i++) {
    if (usedA.has(i)) continue;
    const ca = chartsA[i];
    changes.push(newChange('chart.changed', `${ca.sheet || sheetName}!chart:${ca.id || ca.part}`, {
      sheet: ca.sheet || sheetName,
      before: describeChart(ca),
      after: null,
      beforeLen: chartValues(ca).length,
      afterLen: 0,
    }));
  }
}

function diffMedia(changes, mediaA, mediaB) {
  const byName = new Map(mediaA.map((m) => [m.name, m]));
  const seen = new Set();
  for (const mb of mediaB) {
    const ma = byName.get(mb.name);
    if (!ma) {
      changes.push(newChange('media.changed', `media:${mb.name}`, {
        before: null, after: `新增图片 ${mb.name}（${mb.size}B）`, beforeLen: 0, afterLen: 0,
      }));
    } else if (ma.sha256 !== mb.sha256) {
      changes.push(newChange('media.changed', `media:${mb.name}`, {
        before: `${ma.name} ${ma.size}B ${ma.sha256.slice(0, 8)}`,
        after: `${mb.name} ${mb.size}B ${mb.sha256.slice(0, 8)}`,
        beforeLen: 0, afterLen: 0,
      }));
      seen.add(mb.name);
    } else {
      seen.add(mb.name);
    }
  }
  for (const ma of mediaA) {
    if (seen.has(ma.name)) continue;
    changes.push(newChange('media.changed', `media:${ma.name}`, {
      before: `删除图片 ${ma.name}（${ma.size}B）`, after: null, beforeLen: 0, afterLen: 0,
    }));
  }
}

function diffXlsx(a, b, ctx) {
  const changes = [];
  const stats = { sheetsAdded: 0, sheetsRemoved: 0, sheetsRenamed: 0, movedCells: 0, styleOnly: 0, rowsAdded: 0, rowsRemoved: 0, columnShift: 0 };
  const aByName = new Map(a.sheets.map((s) => [s.name, s]));
  const aUsed = new Set();
  const bUsed = new Set();
  const pairs = new Map(); // b.name -> {a, b}
  const pairsByA = new Map(); // a.name -> {a, b}

  for (const sb of b.sheets) {
    const sa = aByName.get(sb.name);
    if (sa) {
      pairs.set(sb.name, { a: sa, b: sb });
      pairsByA.set(sa.name, { a: sa, b: sb });
      aUsed.add(sa.name);
      bUsed.add(sb.name);
    }
  }
  // 改名识别：未配对 sheet 之间按内容相似度匹配
  const restA = a.sheets.filter((s) => !aUsed.has(s.name));
  const restB = b.sheets.filter((s) => !bUsed.has(s.name));
  for (const sb of restB) {
    let best = null;
    let bestScore = 0;
    for (const sa of restA) {
      if (aUsed.has(sa.name)) continue;
      const score = sheetSimilarity(sa, sb);
      if (score > bestScore) { bestScore = score; best = sa; }
    }
    if (best && bestScore >= 0.4) {
      pairs.set(sb.name, { a: best, b: sb });
      pairsByA.set(best.name, { a: best, b: sb });
      aUsed.add(best.name);
      bUsed.add(sb.name);
      changes.push(newChange('sheet.renamed', `${sb.name}`, {
        sheet: sb.name,
        before: best.name,
        after: sb.name,
        beforeLen: best.name.length,
        afterLen: sb.name.length,
        charDelta: sb.name.length - best.name.length,
        firstDiffAt: commonPrefixLen(best.name, sb.name),
      }));
      stats.sheetsRenamed++;
    }
  }

  // sheet 顺序变化（按名字在两侧的相对位置判断）
  const oldOrder = a.sheets.filter((s) => aUsed.has(s.name))
    .map((s) => (pairsByA.get(s.name) ? pairsByA.get(s.name).b.name : s.name));
  const newOrder = b.sheets.filter((s) => bUsed.has(s.name)).map((s) => s.name);
  const oldIdx = new Map(oldOrder.map((n, i) => [n, i]));
  newOrder.forEach((name, i) => {
    if (oldIdx.has(name) && oldIdx.get(name) !== i) {
      changes.push(newChange('sheet.moved', name, {
        sheet: name,
        before: `第 ${oldIdx.get(name) + 1} 位`,
        after: `第 ${i + 1} 位`,
        beforeLen: 0,
        afterLen: 0,
      }));
    }
  });

  // 逐 sheet 差异（B 的顺序）
  for (const sb of b.sheets) {
    const pair = pairs.get(sb.name);
    if (!pair) {
      changes.push(newChange('sheet.added', sb.name, {
        sheet: sb.name,
        before: null,
        after: `新增工作表「${sb.name}」（${Object.keys(sb.cells || {}).length} 个单元格）`,
        beforeLen: 0,
        afterLen: 0,
      }));
      stats.sheetsAdded++;
      continue;
    }
    const sheetDiff = diffSheetCells(sb.name, pair.a, sb, ctx);
    changes.push(...sheetDiff.changes);
    stats.movedCells += sheetDiff.stats.movedCells;
    stats.styleOnly += sheetDiff.stats.styleOnly;
    stats.rowsAdded += sheetDiff.stats.rowsAdded;
    stats.rowsRemoved += sheetDiff.stats.rowsRemoved;
    stats.columnShift = Math.max(stats.columnShift, sheetDiff.stats.columnShift);
  }
  for (const sa of a.sheets) {
    if (aUsed.has(sa.name)) continue;
    changes.push(newChange('sheet.removed', sa.name, {
      sheet: sa.name,
      before: `删除工作表「${sa.name}」（${Object.keys(sa.cells || {}).length} 个单元格）`,
      after: null,
      beforeLen: 0,
      afterLen: 0,
    }));
    stats.sheetsRemoved++;
  }

  diffCharts(changes, b.sheets[0] ? b.sheets[0].name : '', a.charts || [], b.charts || [], ctx);
  diffMedia(changes, a.media || [], b.media || []);
  return { changes, stats };
}

// ================================================================== docx

function paraEq(a, b) {
  if (a.paraId && b.paraId) return a.paraId === b.paraId;
  return a.text === b.text && a.text.length > 0;
}

function paraAnchor(para) {
  return para.paraId ? `para:${para.paraId}` : `para:#${para.i}`;
}

function tableRowSignature(row) {
  return row.join('\u0001');
}

/** 表格相似度：单元格文本集合 Dice × 0.7 + 行数比例 × 0.3。 */
function tableSimilarity(ta, tb) {
  const cellsOf = (t) => {
    const set = new Set();
    for (const row of t.rows) for (const cell of row) if (cell) set.add(cell);
    return set;
  };
  const sa = cellsOf(ta);
  const sb = cellsOf(tb);
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const v of sa) if (sb.has(v)) inter++;
  const dice = (2 * inter) / (sa.size + sb.size);
  const rowRatio = Math.min(ta.rowCount, tb.rowCount) / Math.max(1, ta.rowCount, tb.rowCount);
  return dice * 0.7 + rowRatio * 0.3;
}

/**
 * 按内容相似度配对表格（表数量变化时不能按 index 硬配，否则整份文档错位）。
 * 返回按 b 侧顺序排列的 [{a, b}]；未配对的另一侧为 null。
 */
function matchTables(tablesA, tablesB) {
  const cands = [];
  for (let i = 0; i < tablesA.length; i++) {
    for (let j = 0; j < tablesB.length; j++) {
      const score = tableSimilarity(tablesA[i], tablesB[j]);
      if (score >= 0.35) cands.push({ i, j, score });
    }
  }
  cands.sort((x, y) => y.score - x.score);
  const usedA = new Set();
  const usedB = new Set();
  const byB = new Map();
  for (const c of cands) {
    if (usedA.has(c.i) || usedB.has(c.j)) continue;
    usedA.add(c.i);
    usedB.add(c.j);
    byB.set(c.j, c.i);
  }
  const out = [];
  for (let j = 0; j < tablesB.length; j++) out.push({ a: byB.has(j) ? byB.get(j) : null, b: j });
  for (let i = 0; i < tablesA.length; i++) if (!usedA.has(i)) out.push({ a: i, b: null });
  return out;
}

/** 表格单元格锚点：改写 r5c2，跨行改写 r5c2→r6c2，新增 +r4c1，删除 -r12c1。 */
function tableCellAnchor(cell, tableIndex) {
  const c = cell.col + 1;
  if (cell.side === 'added') return `table:${tableIndex}/+r${cell.rowB + 1}c${c}`;
  if (cell.side === 'removed') return `table:${tableIndex}/-r${cell.rowA + 1}c${c}`;
  if (cell.rowA === cell.rowB) return `table:${tableIndex}/r${cell.rowA + 1}c${c}`;
  return `table:${tableIndex}/r${cell.rowA + 1}c${c}→r${cell.rowB + 1}c${c}`;
}

function diffTables(changes, tablesA, tablesB, ctx) {
  for (const pair of matchTables(tablesA, tablesB)) {
    const ta = pair.a === null ? null : tablesA[pair.a];
    const tb = pair.b === null ? null : tablesB[pair.b];
    const t = pair.b === null ? pair.a : pair.b;
    if (ta && !tb) {
      changes.push(newChange('table.changed', `table:${t}`, {
        before: `表格 ${t + 1}（${ta.rowCount}×${ta.colCount}）被删除`,
        after: null,
        beforeLen: ta.rowCount * ta.colCount,
        afterLen: 0,
      }));
      continue;
    }
    if (!ta && tb) {
      changes.push(newChange('table.changed', `table:${t}`, {
        before: null,
        after: `新增表格 ${t + 1}（${tb.rowCount}×${tb.colCount}）`,
        beforeLen: 0,
        afterLen: tb.rowCount * tb.colCount,
      }));
      continue;
    }
    const sigA = ta.rows.map(tableRowSignature);
    const sigB = tb.rows.map(tableRowSignature);
    const matches = lcsPairs(sigA, sigB);
    const pairedRows = [];
    const rowSim = (x, y) => (x === '' && y === '' ? 1 : textSimilarity(x, y));
    const flushRows = (i, j) => {
      const gapA = [];
      const gapB = [];
      for (let r = prevI + 1; r < i; r++) gapA.push(r);
      for (let r = prevJ + 1; r < j; r++) gapB.push(r);
      const ops = alignGapsByText(
        gapA.map((r) => ta.rows[r].join('\u0001')),
        gapB.map((r) => tb.rows[r].join('\u0001')),
        0.3,
        rowSim,
      );
      for (const op of ops) {
        pairedRows.push({
          a: op.a === null ? null : gapA[op.a],
          b: op.b === null ? null : gapB[op.b],
        });
      }
    };
    let prevI = -1;
    let prevJ = -1;
    for (const [i, j] of matches) {
      flushRows(i, j);
      pairedRows.push({ a: i, b: j });
      prevI = i;
      prevJ = j;
    }
    flushRows(sigA.length, sigB.length);

    const cells = [];
    for (const pair of pairedRows) {
      if (pair.a !== null && pair.b !== null) {
        const rowA = ta.rows[pair.a];
        const rowB = tb.rows[pair.b];
        const width = Math.max(rowA.length, rowB.length);
        for (let c = 0; c < width; c++) {
          const before = rowA[c] ?? '';
          const after = rowB[c] ?? '';
          if (before !== after) cells.push({ rowA: pair.a, rowB: pair.b, col: c, before, after, side: 'changed' });
        }
      } else if (pair.a !== null) {
        ta.rows[pair.a].forEach((before, c) => cells.push({ rowA: pair.a, rowB: null, col: c, before, after: null, side: 'removed' }));
      } else {
        tb.rows[pair.b].forEach((after, c) => cells.push({ rowA: null, rowB: pair.b, col: c, before: null, after, side: 'added' }));
      }
    }
    if (!cells.length) continue;
    if (cells.length > 30) {
      const first = cells[0];
      const d0 = describeTextChange(first.before, first.after, ctx);
      changes.push(newChange('table.changed', `table:${t}`, {
        before: `${tb.rowCount}×${tb.colCount} 表，${cells.length} 处单元格变化；首处 ${tableCellAnchor(cells[0], t)}：${d0.before}`,
        after: `${d0.after}`,
        beforeLen: 0,
        afterLen: 0,
      }));
    } else {
      for (const cell of cells) {
        const d = describeTextChange(cell.before, cell.after, ctx);
        changes.push(newChange('table.changed', tableCellAnchor(cell, t), {
          before: d.before,
          after: d.after,
          beforeFull: d.beforeFull,
          afterFull: d.afterFull,
          beforeLen: d.beforeLen,
          afterLen: d.afterLen,
          charDelta: d.charDelta,
          firstDiffAt: d.firstDiffAt,
        }));
      }
    }
  }
}

function diffDocx(a, b, ctx) {
  const changes = [];
  const stats = { paragraphsAdded: 0, paragraphsRemoved: 0, paragraphsChanged: 0 };
  const pa = a.paragraphs || [];
  const pb = b.paragraphs || [];
  const matches = lcsPairs(pa, pb, paraEq);
  const paired = [];
  let prevI = -1;
  let prevJ = -1;
  // 两个空段落（排版用的空行）视为可配对，避免「空行增删」刷屏
  const simFn = (x, y) => (x === '' && y === '' ? 1 : textSimilarity(x, y));
  const flushGap = (i, j) => {
    const gapA = [];
    const gapB = [];
    for (let r = prevI + 1; r < i; r++) gapA.push(r);
    for (let r = prevJ + 1; r < j; r++) gapB.push(r);
    const ops = alignGapsByText(gapA.map((r) => pa[r].text), gapB.map((r) => pb[r].text), 0.3, simFn);
    for (const op of ops) {
      paired.push({
        a: op.a === null ? null : gapA[op.a],
        b: op.b === null ? null : gapB[op.b],
      });
    }
  };
  for (const [i, j] of matches) {
    flushGap(i, j);
    paired.push({ a: i, b: j, matched: true });
    prevI = i;
    prevJ = j;
  }
  flushGap(pa.length, pb.length);

  for (const pair of paired) {
    if (pair.a !== null && pair.b !== null) {
      const before = pa[pair.a];
      const after = pb[pair.b];
      const textChanged = before.text !== after.text;
      const styleChanged = before.styleSig !== after.styleSig;
      const levelChanged = before.headingLevel !== after.headingLevel;
      if (textChanged) {
        const d = describeTextChange(before.text, after.text, ctx);
        stats.paragraphsChanged++;
        const anchor = before.paraId || after.paraId ? `para:${after.paraId || before.paraId}` : `para:#${after.i}`;
        changes.push(newChange('para.changed', anchor, {
          before: d.before,
          after: d.after,
          beforeFull: d.beforeFull,
          afterFull: d.afterFull,
          beforeLen: d.beforeLen,
          afterLen: d.afterLen,
          styleChanged,
          charDelta: d.charDelta,
          firstDiffAt: d.firstDiffAt,
        }));
        if (levelChanged) {
          changes.push(newChange('heading.level', anchor, {
            before: before.headingLevel === null ? '正文' : `H${before.headingLevel}`,
            after: after.headingLevel === null ? '正文' : `H${after.headingLevel}`,
            beforeLen: 0,
            afterLen: 0,
          }));
        }
      } else {
        if (levelChanged) {
          // 标题级别变化：单独归为结构类，避免混进纯样式噪声
          const anchor = before.paraId || after.paraId ? `para:${after.paraId || before.paraId}` : `para:#${after.i}`;
          changes.push(newChange('heading.level', anchor, {
            before: before.headingLevel === null ? '正文' : `H${before.headingLevel}`,
            after: after.headingLevel === null ? '正文' : `H${after.headingLevel}`,
            beforeLen: 0,
            afterLen: 0,
          }));
        } else if (styleChanged) {
          const anchor = before.paraId || after.paraId ? `para:${after.paraId || before.paraId}` : `para:#${after.i}`;
          changes.push(newChange('style.changed', anchor, {
            before: before.styleSig,
            after: after.styleSig,
            styleChanged: true,
            beforeLen: 0,
            afterLen: 0,
          }));
        }
      }
    } else if (pair.a !== null) {
      const para = pa[pair.a];
      const d = describeTextChange(para.text, null, ctx);
      stats.paragraphsRemoved++;
      changes.push(newChange('para.removed', paraAnchor(para), {
        before: d.before,
        beforeFull: d.beforeFull,
        after: null,
        beforeLen: d.beforeLen,
        afterLen: 0,
        charDelta: d.charDelta,
        firstDiffAt: d.firstDiffAt,
      }));
    } else {
      const para = pb[pair.b];
      const d = describeTextChange(null, para.text, ctx);
      stats.paragraphsAdded++;
      changes.push(newChange('para.added', paraAnchor(para), {
        before: null,
        after: d.after,
        afterFull: d.afterFull,
        beforeLen: 0,
        afterLen: d.afterLen,
        charDelta: d.charDelta,
        firstDiffAt: d.firstDiffAt,
      }));
    }
  }

  diffTables(changes, a.tables || [], b.tables || [], ctx);

  // 页眉页脚
  const hfKeys = new Set([...Object.keys(a.headersFooters || {}), ...Object.keys(b.headersFooters || {})]);
  for (const key of hfKeys) {
    const ha = (a.headersFooters || {})[key] || [];
    const hb = (b.headersFooters || {})[key] || [];
    if (JSON.stringify(ha.map((p) => p.text)) !== JSON.stringify(hb.map((p) => p.text))) {
      changes.push(newChange('para.changed', `${key}`, {
        before: ha.map((p) => p.text).join(' / ').slice(0, 120) || null,
        after: hb.map((p) => p.text).join(' / ').slice(0, 120) || null,
        beforeLen: ha.reduce((n, p) => n + p.text.length, 0),
        afterLen: hb.reduce((n, p) => n + p.text.length, 0),
      }));
    }
  }
  return { changes, stats };
}

// ================================================================== pptx

function diffPptx(a, b, ctx) {
  const changes = [];
  const stats = { slidesAdded: 0, slidesRemoved: 0, shapesChanged: 0 };
  const sa = a.slides || [];
  const sb = b.slides || [];
  const max = Math.max(sa.length, sb.length);
  for (let i = 0; i < max; i++) {
    const before = sa[i];
    const after = sb[i];
    if (before && !after) {
      changes.push(newChange('slide.removed', `slide:${before.index}`, {
        before: `第 ${before.index} 页（${before.shapes.length} 个形状）被删除`,
        after: null,
      }));
      stats.slidesRemoved++;
      continue;
    }
    if (!before && after) {
      changes.push(newChange('slide.added', `slide:${after.index}`, {
        before: null,
        after: `新增第 ${after.index} 页${after.shapes[0] && after.shapes[0].text ? `：${after.shapes[0].text.slice(0, 60)}` : ''}`,
      }));
      stats.slidesAdded++;
      continue;
    }
    const shapeA = new Map(before.shapes.map((s, idx) => [s.name || `#${idx}`, s]));
    const shapeB = new Map(after.shapes.map((s, idx) => [s.name || `#${idx}`, s]));
    for (const [key, sbShape] of shapeB) {
      const saShape = shapeA.get(key);
      if (!saShape) {
        changes.push(newChange('slide.changed', `slide:${after.index}/shape:${key}`, {
          before: null,
          after: sbShape.text || '（无文本形状）',
        }));
        stats.shapesChanged++;
      } else if (saShape.text !== sbShape.text) {
        const d = describeTextChange(saShape.text, sbShape.text, ctx);
        changes.push(newChange('shape.text.changed', `slide:${after.index}/shape:${key}`, {
          before: d.before,
          after: d.after,
          beforeFull: d.beforeFull,
          afterFull: d.afterFull,
          beforeLen: d.beforeLen,
          afterLen: d.afterLen,
          charDelta: d.charDelta,
          firstDiffAt: d.firstDiffAt,
        }));
        stats.shapesChanged++;
      }
    }
    for (const [key, saShape] of shapeA) {
      if (!shapeB.has(key)) {
        changes.push(newChange('slide.changed', `slide:${after.index}/shape:${key}`, {
          before: saShape.text || '（无文本形状）',
          after: null,
        }));
        stats.shapesChanged++;
      }
    }
  }
  return { changes, stats };
}

// ================================================================== 主入口

/**
 * 对比两份同类型快照。
 * @param {object} a 旧快照
 * @param {object} b 新快照
 * @param {{noContent?:boolean, window?:number, maxLen?:number, styleNoiseThreshold?:number, changeLimit?:number}} [opts]
 * @returns {{docType:string, changes:object[], counts:object, totalChanges:number, truncated:boolean, stats:object}}
 */
export function diffSnapshots(a, b, opts = {}) {
  const docType = (b && b.docType) || (a && a.docType) || 'unknown';
  if (a && a.docType && b && b.docType && a.docType !== b.docType) {
    throw new Error(`diff: 文档类型不一致（${a.docType} vs ${b.docType}）`);
  }
  const ctx = {
    noContent: Boolean(opts.noContent),
    window: opts.window || WINDOW,
    maxLen: opts.maxLen || SUMMARY_MAX,
    fullTextLimit: opts.fullTextLimit || FULL_TEXT_LIMIT,
    styleNoiseThreshold: opts.styleNoiseThreshold ?? 10,
  };
  let result;
  if (docType === 'xlsx') result = diffXlsx(a, b, ctx);
  else if (docType === 'docx') result = diffDocx(a, b, ctx);
  else if (docType === 'pptx') result = diffPptx(a, b, ctx);
  else throw new Error(`diff: 不支持的文档类型 ${docType}`);

  const limit = opts.changeLimit ?? DEFAULT_CHANGE_LIMIT;
  const totalChanges = result.changes.length;
  const changes = totalChanges > limit ? result.changes.slice(0, limit) : result.changes;
  const counts = countKinds(result.changes);
  return {
    docType,
    changes,
    counts,
    totalChanges,
    truncated: totalChanges > limit,
    stats: result.stats,
  };
}

/** 生成一句话摘要（journal.summary 用），聚焦「改在哪、改了多少」。 */
export function summarizeDiff(result, opts = {}) {
  const { changes, counts, stats } = result;
  const total = result.totalChanges ?? changes.length;
  if (!total) {
    const moved = stats && stats.movedCells ? `（另有 ${stats.movedCells} 个单元格整体搬移，未计入）` : '';
    return `无实质改动${moved}`;
  }
  const groups = { structure: 0, text: 0, chart: 0, other: 0 };
  for (const c of changes) groups[classifyChange(c.kind)]++;
  const focus = new Map();
  for (const c of changes) {
    const key = c.sheet || (c.anchor.startsWith('para:') ? '正文段落' : (c.anchor.startsWith('table:') ? '表格' : (c.anchor.startsWith('slide:') ? '幻灯片' : c.anchor.split('!')[0])));
    focus.set(key, (focus.get(key) || 0) + 1);
  }
  const top = [...focus.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3)
    .map(([k, n]) => `「${k}」${n} 处`).join('、');
  const bits = [];
  if (groups.structure) bits.push(`结构 ${groups.structure}`);
  if (groups.text) bits.push(`文本 ${groups.text}`);
  if (groups.chart) bits.push(`图表 ${groups.chart}`);
  if (groups.other) bits.push(`样式/其他 ${groups.other}`);
  const moved = stats && stats.movedCells ? `；另有 ${stats.movedCells} 个单元格整体搬移（未计入）` : '';
  const rowShift = stats && (stats.rowsAdded || stats.rowsRemoved)
    ? `；行增删 ${stats.rowsAdded || 0}/${stats.rowsRemoved || 0}` : '';
  return `${total} 处实质改动（${bits.join(' / ')}），集中在${top}${moved}${rowShift}`;
}
