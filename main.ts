// mend: one command-line tool that applies AI-written edits in four formats
// (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool calls) to a
// tree of text files, to SPEC.md. Node 22, standard library alone.
// Run as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`.
// In a trial (MAKEFUN_ENV_URL set) it hands over to runner.ts.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// --- File line model (SPEC.md section 3) ---

interface FileParts {
  br: string;
  lines: string[];
  final: boolean;
}

function fileParts(text: string): FileParts {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    lines.pop();
    final = true;
  }
  return { br, lines, final };
}

function joinParts(br: string, lines: string[], final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function stripTrailWS(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBothWS(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// --- Line matching (SPEC.md section 5) ---

interface NLine {
  text: string;
  oPos: number | null;
}

function keyAt(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return stripTrailWS(line);
  return stripBothWS(line);
}

function occurrencesAt(F: string[], O: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const pos: number[] = [];
  for (let i = from; i + O.length <= F.length; i++) {
    if (eofOnly && i + O.length !== F.length) continue;
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (keyAt(F[i + j]!, tier) !== keyAt(O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

function findTier(F: string[], O: string[], from: number, strict: boolean, eofOnly: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(F, O, t, from, eofOnly);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

// Map the new lines of a match onto the file: context lines are written as
// the file's own matched lines; at tier 2 the other lines are re-indented.
function mapNew(F: string[], i: number, O: string[], N: NLine[], tier: number): string[] {
  const P = O.length > 0 ? leadingWS(O[0]!) : '';
  const Fws = leadingWS(F[i]!);
  return N.map((n) => {
    if (n.oPos !== null) return F[i + n.oPos]!;
    if (tier === 2 && n.text !== '' && n.text.trim() !== '' && n.text.startsWith(P)) return Fws + n.text.slice(P.length);
    return n.text;
  });
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// --- Unified diffs (SPEC.md section 6) ---

interface Tok {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  empty: boolean;
}

interface Hunk {
  a: number;
  toks: Tok[];
}

interface UniSection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renFrom: string | null;
  renTo: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function stripPath(raw: string): string {
  let p = raw.split('\t')[0]!.trim();
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

function collectBody(lines: string[], start: number): { toks: Tok[]; next: number } {
  const toks: Tok[] = [];
  let j = start;
  const n = lines.length;
  while (j < n) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      toks.push({ kind: 'ctx', text: '', empty: true });
      j++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      toks.push({ kind: 'ctx', text: l.slice(1), empty: false });
      j++;
      continue;
    }
    if (c === '-') {
      toks.push({ kind: 'old', text: l.slice(1), empty: false });
      j++;
      continue;
    }
    if (c === '+') {
      toks.push({ kind: 'new', text: l.slice(1), empty: false });
      j++;
      continue;
    }
    if (c === '\\') {
      toks.push({ kind: 'bs', text: l.slice(1), empty: false });
      j++;
      continue;
    }
    break;
  }
  while (toks.length > 0 && toks[toks.length - 1]!.empty) toks.pop();
  return { toks, next: j };
}

// True when a `\` line immediately follows the hunk's last context or `+` line.
function bsAfterLastCtxOrNew(toks: Tok[]): boolean {
  for (let j = toks.length - 1; j >= 0; j--) {
    const t = toks[j]!;
    if (t.kind === 'ctx' || t.kind === 'new') {
      const nx = toks[j + 1];
      return nx !== undefined && nx.kind === 'bs';
    }
  }
  return false;
}

function hunkDelta(h: Hunk): number {
  let o = 0;
  let n = 0;
  for (const t of h.toks) {
    if (t.kind === 'bs') continue;
    if (t.kind === 'ctx') {
      o++;
      n++;
    } else if (t.kind === 'old') o++;
    else if (t.kind === 'new') n++;
  }
  return n - o;
}

function applyHunk(fp: FileParts, hunk: Hunk, d: number, strict: boolean, path: string): FileParts {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const t of hunk.toks) {
    if (t.kind === 'bs') continue;
    if (t.kind === 'ctx') {
      O.push(t.text);
      N.push({ text: t.text, oPos: O.length - 1 });
    } else if (t.kind === 'old') {
      O.push(t.text);
    } else if (t.kind === 'new') {
      N.push({ text: t.text, oPos: null });
    }
  }
  const lines = fp.lines;
  if (O.length > 0) {
    const found = findTier(lines, O, 0, strict, false);
    if (found === null) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist || (dist === bestDist && p < best)) {
        best = p;
        bestDist = dist;
      }
    }
    const mapped = mapNew(lines, best, O, N, found.tier);
    const newLines = [...lines.slice(0, best), ...mapped, ...lines.slice(best + O.length)];
    let final = fp.final;
    if (best + O.length === lines.length) final = !bsAfterLastCtxOrNew(hunk.toks);
    return { br: fp.br, lines: newLines, final };
  }
  const p = Math.max(0, Math.min(hunk.a + d, lines.length));
  const ins = N.map((x) => x.text);
  const newLines = [...lines.slice(0, p), ...ins, ...lines.slice(p)];
  let final = fp.final;
  if (p === lines.length && ins.length > 0) final = !bsAfterLastCtxOrNew(hunk.toks);
  return { br: fp.br, lines: newLines, final };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const secs: UniSection[] = [];
  let cur: UniSection | null = null;
  let phase: 'header' | 'between' = 'header';
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
  const diffRe = /^diff --git a\/(\S+) b\/(\S+)$/;
  const newSec = (gOld: string | null, gNew: string | null): void => {
    cur = { gitOld: gOld, gitNew: gNew, pairOld: null, pairNew: null, hasPair: false, renFrom: null, renTo: null, create: false, del: false, hunks: [] };
    secs.push(cur);
    phase = 'header';
  };
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = diffRe.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      newSec(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && phase === 'header' && !cur.hasPair) {
        // This is the section's own header pair: fall through to header handling.
      } else {
        newSec(null, null);
        continue;
      }
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), toks: [] };
      cur.hunks.push(hunk);
      phase = 'between';
      i++;
      const body = collectBody(lines, i);
      hunk.toks = body.toks;
      i = body.next;
      continue;
    }
    if (cur === null) {
      i++;
      continue;
    }
    if (phase === 'header') {
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.pairOld = stripPath(l.slice(4));
          cur.pairNew = stripPath(lines[i + 1]!.slice(4));
          cur.hasPair = true;
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('rename from ')) {
        if (cur.renFrom === null) cur.renFrom = l.slice(12).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        if (cur.renTo === null) cur.renTo = l.slice(10).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.create = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.del = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return secs.map((s) => uniEdit(s, strict));
}

function uniEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.hasPair ? sec.pairOld! : (sec.renFrom ?? sec.gitOld ?? '');
    const newP = sec.hasPair ? sec.pairNew! : (sec.renTo ?? sec.gitNew ?? '');
    const isCreate = oldP === '/dev/null' || sec.create;
    const isDelete = !isCreate && (newP === '/dev/null' || sec.del);
    if (isCreate) {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let lastPlus: { hunk: Hunk; idx: number } | null = null;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.toks.length; k++) {
          if (h.toks[k]!.kind === 'new') {
            plus.push(h.toks[k]!.text);
            lastPlus = { hunk: h, idx: k };
          }
        }
      }
      let noNl = false;
      if (lastPlus !== null) {
        const t = lastPlus.hunk.toks[lastPlus.idx + 1];
        noNl = t !== undefined && t.kind === 'bs';
      }
      const text = plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n');
      tree.now.set(newP, text);
      return;
    }
    if (isDelete) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (!safe(newP)) throw new Fail('unsafe', newP);
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    const isMove = oldP !== newP;
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    let fp = fileParts(cur);
    let d = 0;
    for (const h of sec.hunks) {
      fp = applyHunk(fp, h, d, strict, oldP);
      d += hunkDelta(h);
    }
    const text = joinParts(fp.br, fp.lines, fp.final);
    if (isMove) {
      tree.now.set(newP, text);
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, text);
    }
  };
}

// --- SEARCH/REPLACE blocks (SPEC.md section 7) ---

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const fp = fileParts(cur);
    const found = findTier(fp.lines, oldLines, 0, strict, false);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const i = found.pos[0]!;
    const N: NLine[] = newLines.map((t) => ({ text: t, oPos: null }));
    const mapped = mapNew(fp.lines, i, oldLines, N, found.tier);
    const out = [...fp.lines.slice(0, i), ...mapped, ...fp.lines.slice(i + oldLines.length)];
    tree.now.set(path, joinParts(fp.br, out, fp.final));
  };
}

function parseSR(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  let prevReplaceEnd = 0;
  let prevPath: string | null = null;
  while (i < n) {
    let s = -1;
    for (let j = i; j < n; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j >= prevReplaceEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplaceEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// --- V4A patches (SPEC.md section 8) ---

interface VChunk {
  anchor: string;
  toks: Tok[];
  eof: boolean;
}

function v4aAddEdit(path: string, secLines: string[], _strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, secLines.length === 0 ? '' : secLines.join('\n') + '\n');
  };
}

function v4aDelEdit(path: string, _strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let fp = fileParts(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== '') {
        const found = findTier(fp.lines, [ch.anchor], cursor, strict, false);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.pos[0]! + 1;
      }
      const O: string[] = [];
      const N: NLine[] = [];
      for (const t of ch.toks) {
        if (t.kind === 'bs') continue;
        if (t.kind === 'ctx') {
          O.push(t.text);
          N.push({ text: t.text, oPos: O.length - 1 });
        } else if (t.kind === 'old') {
          O.push(t.text);
        } else if (t.kind === 'new') {
          N.push({ text: t.text, oPos: null });
        }
      }
      if (O.length > 0) {
        const found = findTier(fp.lines, O, cursor, strict, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const i = found.pos[0]!;
        const mapped = mapNew(fp.lines, i, O, N, found.tier);
        fp = { br: fp.br, lines: [...fp.lines.slice(0, i), ...mapped, ...fp.lines.slice(i + O.length)], final: fp.final };
        cursor = i + mapped.length;
      } else {
        const p = ch.eof ? fp.lines.length : cursor;
        const ins = N.map((x) => x.text);
        fp = { br: fp.br, lines: [...fp.lines.slice(0, p), ...ins, ...fp.lines.slice(p)], final: fp.final };
        cursor = p + ins.length;
      }
    }
    const text = joinParts(fp.br, fp.lines, fp.final);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  let first = -1;
  for (let j = 0; j < n; j++) {
    if (!blank(lines[j]!)) {
      first = j;
      break;
    }
  }
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = n - 1; j >= 0; j--) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const isSectionStart = (m: string): boolean =>
    m.startsWith('*** Add File: ') || m.startsWith('*** Delete File: ') || m.startsWith('*** Update File: ');
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const secLines: string[] = [];
      i++;
      while (i < last) {
        const m = lines[i]!;
        if (isSectionStart(m)) break;
        if (m.startsWith('+')) {
          secLines.push(m.slice(1));
          i++;
          continue;
        }
        if (m === '') {
          secLines.push('');
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (secLines.length > 0 && secLines[secLines.length - 1] === '') secLines.pop();
      edits.push(v4aAddEdit(path, secLines, strict));
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last) {
        const m = lines[i]!;
        if (isSectionStart(m)) break;
        if (blank(m)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(v4aDelEdit(path, strict));
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const updLine = i;
      const path = l.slice('*** Update File: '.length).trim();
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const endChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const m = lines[i]!;
        if (isSectionStart(m)) break;
        if (m.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${i + 1}`);
        if (m.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          endChunk();
          i++;
          continue;
        }
        if (m.startsWith('*** ')) throw new Exit2(`error: parse ${i + 1}`);
        if (m.startsWith('@@')) {
          endChunk();
          cur = { anchor: m.slice(2).trim(), toks: [], eof: false };
          i++;
          continue;
        }
        if (m === '' || m[0] === ' ' || m[0] === '-' || m[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) {
              // A blank line after a chunk closed (e.g. after *** End of File)
              // is a blank line at the end of the section: not part of it.
              if (m.trim() === '') {
                i++;
                continue;
              }
              throw new Exit2(`error: parse ${i + 1}`);
            }
            cur = { anchor: '', toks: [], eof: false };
          }
          if (m === '') cur.toks.push({ kind: 'ctx', text: '', empty: true });
          else if (m[0] === ' ') cur.toks.push({ kind: 'ctx', text: m.slice(1), empty: false });
          else if (m[0] === '-') cur.toks.push({ kind: 'old', text: m.slice(1), empty: false });
          else cur.toks.push({ kind: 'new', text: m.slice(1), empty: false });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      endChunk();
      if (chunks.length > 0) {
        // Blank lines at the end of a section are not part of it: a blank
        // line is empty or only whitespace (SPEC.md section 4), so a context
        // line whose text is only whitespace counts here, not just an empty
        // line. Without this, a trailing ' ' context line would add an empty
        // line to O that the file cannot match at its end.
        const lc = chunks[chunks.length - 1]!;
        while (lc.toks.length > 0) {
          const t = lc.toks[lc.toks.length - 1]!;
          if (t.kind === 'ctx' && t.text.trim() === '') lc.toks.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updLine + 1}`);
      edits.push(v4aUpdEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// --- Run ---

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSR(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  const changed = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const p of changed) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!covered.has(p)) rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  if (!check) {
    for (const p of changed) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now || now !== null) continue;
      rmSync(p, { force: true });
    }
    for (const p of changed) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now || now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
