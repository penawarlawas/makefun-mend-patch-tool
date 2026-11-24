// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, as [old path, new path]. */
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

/** A file's lines, its line break, and whether it ended with one (SPEC.md section 3). */
function fileLines(text: string): { lines: string[]; br: string; final: boolean } {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const final = text.endsWith(br);
  const body = final ? text.slice(0, -br.length) : text;
  return { lines: body.split(br), br, final };
}

function fileText(lines: string[], br: string, final: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

const stripEnd = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+|[ \t]+$/g, '');
const lead = (s: string): string => /^[ \t]*/.exec(s)![0];

function equalTier(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripEnd(a) === stripEnd(b);
  return stripBoth(a) === stripBoth(b);
}

/** The first tier at which `o` occurs in `file`, with every 0-based occurrence position (SPEC.md section 5). */
function findTier(file: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  for (let tier = 0; tier <= 2; tier += 1) {
    if (strict && tier > 0) break;
    const occ: number[] = [];
    for (let i = 0; i + o.length <= file.length; i += 1) {
      let ok = true;
      for (let j = 0; j < o.length && ok; j += 1) ok = equalTier(o[j]!, file[i + j]!, tier);
      if (ok) occ.push(i);
    }
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** One hunk body line: ' ' context, '-' old, '+' new, '\' no-newline marker. */
interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  old: string | null;
  new: string | null;
  pair: boolean;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

interface Applied {
  lines: string[];
  eof: boolean | null;
}

function applyHunks(file: string[], hunks: Hunk[], strict: boolean, path: string): Applied {
  const lines = file.slice();
  let d = 0;
  let eof: boolean | null = null;
  for (const h of hunks) {
    const o: string[] = [];
    const n: { text: string; ctx: boolean }[] = [];
    for (const b of h.body) {
      if (b.kind === ' ') {
        o.push(b.text);
        n.push({ text: b.text, ctx: true });
      } else if (b.kind === '-') o.push(b.text);
      else if (b.kind === '+') n.push({ text: b.text, ctx: false });
    }
    let tier = 0;
    let pos: number;
    if (o.length === 0) {
      pos = Math.min(h.a + d, lines.length);
    } else {
      const found = findTier(lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      tier = found.tier;
      const target = h.a - 1 + d;
      pos = found.occ[0]!;
      for (const p of found.occ) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    }
    const P = o.length > 0 ? lead(o[0]!) : '';
    const F = tier === 2 && o.length > 0 ? lead(lines[pos]!) : '';
    // Walk the body in order: `-` and ` ` both consume a matched line, `+` adds one.
    const repl: string[] = [];
    let oc = 0;
    for (const b of h.body) {
      if (b.kind === ' ' || b.kind === '-') {
        if (b.kind === ' ') repl.push(lines[pos + oc]!);
        oc += 1;
      } else if (b.kind === '+') {
        repl.push(tier === 2 && o.length > 0 && !blank(b.text) && b.text.startsWith(P) ? F + b.text.slice(P.length) : b.text);
      }
    }
    if (pos + o.length === lines.length) {
      let last = -1;
      h.body.forEach((b, k) => {
        if (b.kind === ' ' || b.kind === '+') last = k;
      });
      eof = !(last >= 0 && h.body[last + 1]?.kind === '\\');
    }
    lines.splice(pos, o.length, ...repl);
    d += n.length - o.length;
  }
  return { lines, eof };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const pathOf = (line: string): string | null => {
    const t = line.slice(4).split('\t')[0]!.trim();
    if (t === '/dev/null') return null;
    return t.startsWith('a/') || t.startsWith('b/') ? t.slice(2) : t;
  };
  const fresh = (): Section => ({ old: null, new: null, pair: false, create: false, del: false, hunks: [] });
  const secs: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const parts = l.slice('diff --git '.length).split(' ');
      if (parts.length !== 2 || !parts[0]!.startsWith('a/') || !parts[1]!.startsWith('b/')) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.old = parts[0]!.slice(2);
      cur.new = parts[1]!.slice(2);
      secs.push(cur);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0 || cur.pair) {
        cur = fresh();
        secs.push(cur);
      }
      cur.old = pathOf(l);
      cur.new = pathOf(lines[i + 1]!);
      cur.pair = true;
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ') || (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ '))) break;
        if (b === '') body.push({ kind: ' ', text: '' });
        else if (b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') body.push({ kind: b[0], text: b.slice(1) });
        else break;
        j += 1;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '') body.pop();
      cur.hunks.push({ a: Number(m[1]), body });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('rename from ') && !cur.pair) cur.old = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ') && !cur.pair) cur.new = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.create = true;
      else if (l.startsWith('deleted file mode')) cur.del = true;
    }
    i += 1;
  }
  return secs.map((sec) => (tree: Tree): void => {
    for (const p of [sec.old, sec.new]) if (p !== null && !safe(p)) throw new Fail('unsafe', p);
    if (sec.old === null || sec.create) {
      const np = sec.new;
      if (np === null) return;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const all: BodyLine[] = [];
      for (const h of sec.hunks) all.push(...h.body);
      const out: string[] = [];
      let last = -1;
      all.forEach((b, k) => {
        if (b.kind === '+') {
          out.push(b.text);
          last = k;
        }
      });
      tree.now.set(np, out.length === 0 ? '' : out.join('\n') + (all[last + 1]?.kind === '\\' ? '' : '\n'));
      return;
    }
    if (sec.new === null || sec.del) {
      const op = sec.old;
      if (op === null) return;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = sec.old;
    const np = sec.new;
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    const moving = np !== op;
    if (moving && tree.get(np) !== null) throw new Fail('exists', np);
    const f = fileLines(before);
    const got = applyHunks(f.lines, sec.hunks, strict, op);
    const text = fileText(got.lines, f.br, got.eof ?? f.final);
    if (moving) {
      tree.now.set(op, null);
      tree.now.set(np, text);
      tree.moves.push([op, np]);
    } else tree.now.set(np, text);
  });
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const isSearch = (l: string): boolean => stripEnd(l) === '<<<<<<< SEARCH';
  const isSep = (l: string): boolean => stripEnd(l) === '=======';
  const isRepl = (l: string): boolean => stripEnd(l) === '>>>>>>> REPLACE';
  const blocks: { path: string; old: string[]; next: string[] }[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (!isSearch(lines[i]!)) continue;
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    let sep = -1;
    for (let j = i + 1; j < lines.length && sep < 0; j += 1) if (isSep(lines[j]!)) sep = j;
    let end = -1;
    if (sep >= 0) for (let j = sep + 1; j < lines.length && end < 0; j += 1) if (isRepl(lines[j]!)) end = j;
    if (end < 0) throw new Exit2(`error: parse ${i + 1}`);
    blocks.push({ path, old: lines.slice(i + 1, sep), next: lines.slice(sep + 1, end) });
    prevEnd = end;
    prevPath = path;
    i = end;
  }
  return blocks.map((b) => (tree: Tree): void => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.old.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.next.length === 0 ? '' : `${b.next.join('\n')}\n`);
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const f = fileLines(before);
    const found = findTier(f.lines, b.old, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
    const pos = found.occ[0]!;
    let next = b.next;
    if (found.tier === 2) {
      const P = lead(b.old[0]!);
      const F = lead(f.lines[pos]!);
      next = b.next.map((t) => (!blank(t) && t.startsWith(P) ? F + t.slice(P.length) : t));
    }
    f.lines.splice(pos, b.old.length, ...next);
    tree.now.set(b.path, fileText(f.lines, f.br, f.final));
  });
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  move: string | null;
  body: string[];
  chunks: VChunk[];
  at: number;
}

function applyChunks(file: string[], chunks: VChunk[], strict: boolean, path: string): string[] {
  const lines = file.slice();
  let cursor = 0;
  for (const c of chunks) {
    if (c.anchor !== null) {
      let at = -1;
      for (let tier = 0; tier <= 2 && at < 0; tier += 1) {
        if (strict && tier > 0) break;
        for (let i = cursor; i < lines.length; i += 1) {
          if (equalTier(c.anchor, lines[i]!, tier)) {
            at = i;
            break;
          }
        }
      }
      if (at < 0) throw new Fail('no-match', path);
      cursor = at + 1;
    }
    const o = c.body.filter((b) => b.kind === ' ' || b.kind === '-').map((b) => b.text);
    let pos = 0;
    let tier = 0;
    if (o.length === 0) {
      pos = c.eof ? lines.length : cursor;
    } else {
      let found = false;
      for (let t = 0; t <= 2 && !found; t += 1) {
        if (strict && t > 0) break;
        for (let i = cursor; i + o.length <= lines.length; i += 1) {
          let ok = true;
          for (let j = 0; j < o.length && ok; j += 1) ok = equalTier(o[j]!, lines[i + j]!, t);
          if (ok && (!c.eof || i + o.length === lines.length)) {
            pos = i;
            tier = t;
            found = true;
            break;
          }
        }
      }
      if (!found) throw new Fail('no-match', path);
    }
    const P = o.length > 0 ? lead(o[0]!) : '';
    const F = tier === 2 && o.length > 0 ? lead(lines[pos]!) : '';
    const repl: string[] = [];
    let oc = 0;
    for (const b of c.body) {
      if (b.kind === ' ') {
        repl.push(lines[pos + oc]!);
        oc += 1;
      } else if (b.kind === '-') oc += 1;
      else if (b.kind === '+') {
        repl.push(tier === 2 && o.length > 0 && !blank(b.text) && b.text.startsWith(P) ? F + b.text.slice(P.length) : b.text);
      }
    }
    lines.splice(pos, o.length, ...repl);
    cursor = pos + repl.length;
  }
  return lines;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secs: { sec: VSection; raw: { l: string; idx: number }[] }[] = [];
  let cur: { sec: VSection; raw: { l: string; idx: number }[] } | null = null;
  for (let i = first + 1; i < last; i += 1) {
    const l = lines[i]!;
    let sec: VSection | null = null;
    if (l.startsWith('*** Add File: ')) sec = { kind: 'add', path: l.slice('*** Add File: '.length).trim(), move: null, body: [], chunks: [], at: i };
    else if (l.startsWith('*** Delete File: ')) sec = { kind: 'del', path: l.slice('*** Delete File: '.length).trim(), move: null, body: [], chunks: [], at: i };
    else if (l.startsWith('*** Update File: ')) sec = { kind: 'upd', path: l.slice('*** Update File: '.length).trim(), move: null, body: [], chunks: [], at: i };
    if (sec !== null) {
      cur = { sec, raw: [] };
      secs.push(cur);
      continue;
    }
    if (cur === null) {
      if (blank(l)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    cur.raw.push({ l, idx: i });
  }
  for (const { sec, raw } of secs) {
    while (raw.length > 0 && blank(raw[raw.length - 1]!.l)) raw.pop();
    if (sec.kind === 'add') {
      for (const r of raw) {
        if (r.l === '') sec.body.push('');
        else if (r.l.startsWith('+')) sec.body.push(r.l.slice(1));
        else throw new Exit2(`error: parse ${r.idx + 1}`);
      }
    } else if (sec.kind === 'del') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.idx + 1}`);
    } else {
      let k = 0;
      if (raw.length > 0 && raw[0]!.l.startsWith('*** Move to: ')) {
        sec.move = raw[0]!.l.slice('*** Move to: '.length).trim();
        k = 1;
      }
      let chunk: VChunk | null = null;
      for (; k < raw.length; k += 1) {
        const { l, idx } = raw[k]!;
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          sec.chunks.push(chunk);
        } else if (stripEnd(l) === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${idx + 1}`);
          chunk.eof = true;
          chunk = null;
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (chunk === null) {
            if (sec.chunks.length > 0) throw new Exit2(`error: parse ${idx + 1}`);
            chunk = { anchor: null, eof: false, body: [] };
            sec.chunks.push(chunk);
          }
          chunk.body.push(l === '' ? { kind: ' ', text: '' } : { kind: l[0] as ' ' | '-' | '+', text: l.slice(1) });
        } else {
          throw new Exit2(`error: parse ${idx + 1}`);
        }
      }
      if (sec.move === null && sec.chunks.length === 0) throw new Exit2(`error: parse ${sec.at + 1}`);
    }
  }
  return secs.map(({ sec }) => (tree: Tree): void => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.move !== null && !safe(sec.move)) throw new Fail('unsafe', sec.move);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.body.length === 0 ? '' : `${sec.body.join('\n')}\n`);
      return;
    }
    if (sec.kind === 'del') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    const moving = sec.move;
    if (moving !== null && tree.get(moving) !== null) throw new Fail('exists', moving);
    const f = fileLines(before);
    const text = fileText(applyChunks(f.lines, sec.chunks, strict, sec.path), f.br, f.final);
    if (moving !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(moving, text);
      tree.moves.push([sec.path, moving]);
    } else tree.now.set(sec.path, text);
  });
}

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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'search-replace'
          ? searchReplaceEdits(lines, strict)
          : kind === 'v4a'
            ? v4aEdits(lines, strict)
            : unifiedEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { sort: string; line: string }[] = [];
  const moved = new Map<string, string>();
  const fromMove = new Set<string>();
  for (const [o, n] of tree.moves) {
    moved.set(o, n);
    fromMove.add(n);
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (now === null && moved.has(p)) continue;
    if (was === null && fromMove.has(p)) {
      // A move's new path replaces the pair's D and A lines, sorted by the new path.
      const old = [...moved.entries()].find(([, n]) => n === p)![0];
      rows.push({ sort: p, line: `R ${old} -> ${p}` });
      continue;
    }
    rows.push({ sort: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort)));
  for (const p of [...tree.now.keys()]) {
    if (check) continue;
    const now = tree.now.get(p)!;
    if (tree.original(p) === now) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
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
