// The data terminal: every section of the page dealt into columns (three at
// least, one more per 560 px), each to the shortest so far, the same deal
// again on every refresh. Sashes resize; the widths are kept per page.
//
// Eight quadrants: on a wide screen the sections are dealt into a grid of
// four columns by two rows, eight panes that scroll on their own. The first
// eight sections get a pane each; any more go to the pane with the least in
// it. Sashes resize columns and rows (kept per page); double-click resets.
// Q, or the ▦ button in the header, flips between quadrants and columns.
import { POP } from './env.ts';
import { addPops, applyPop } from './popout.ts';
import { TC } from './store.ts';
import { isTypingTarget } from './util.ts';

const SKIP_TAGS = /^(SCRIPT|STYLE|TEMPLATE)$/;
/** Pane accent colours, one per quadrant. */
const COLORS = ['#5a9bff', '#3fb950', '#f6c343', '#ff6b6b', '#b48cff', '#e3a35a', '#2bb3c0', '#ff4fd8'] as const;

/**
 * A dealt item. Usually an HTMLElement; an <svg> sitting directly in <main>
 * (or in a wrapper that also holds sections) is dealt too, as in the original.
 */
export type Item = HTMLElement | SVGElement;

/** offsetParent; undefined for SVG (which the original treated as "visible"). */
function offsetParentOf(it: Item): Element | null | undefined {
  return it instanceof HTMLElement ? it.offsetParent : undefined;
}

/** offsetHeight; undefined for SVG. */
function offsetHeightOf(it: Item): number | undefined {
  return it instanceof HTMLElement ? it.offsetHeight : undefined;
}

function readJson(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

function isNumArray(v: unknown, len: number): v is number[] {
  return Array.isArray(v) && v.length === len;
}

/** `1fr 5px 1fr 5px 1fr` from fractions (each at least 0.05). */
export function tracks(a: readonly number[]): string {
  return a.map((f) => Math.max(0.05, f).toFixed(3) + 'fr').join(' 5px ');
}

function resized(): void {
  window.dispatchEvent(new Event('resize'));
}

export function quadMode(): boolean {
  let m: string | null = null;
  try {
    m = localStorage.getItem('layout.mode');
  } catch {
    /* blocked storage */
  }
  return window.innerWidth >= 1200 && m !== 'cols';
}

/** Flip quadrants/columns. NB: a full page reload, unlike refreshMain. */
export function toggleQuads(): void {
  try {
    localStorage.setItem('layout.mode', quadMode() ? 'cols' : 'quads');
  } catch {
    /* blocked storage */
  }
  TC.colPlan = null;
  location.reload();
}

/** A grid cell of the quadrant layout. */
export interface Cell {
  col: number;
  row: 0 | 1;
  /** Full-height (rows 1..3 incl. the sash row). */
  span?: boolean;
}

/**
 * How many columns (C) and tall full-height columns (T) for n visible sections:
 * eight cells, four columns by two rows. With fewer than eight sections the
 * tallest take a whole column each until the eight cells are used.
 */
export function quadShape(n: number): { C: number; T: number } {
  const C = n >= 4 ? 4 : n;
  const T = n >= 8 ? 0 : n >= 4 ? 8 - n : C;
  return { C, T };
}

/** Cells: tall columns on the left in page order, then quadrant pairs. */
export function quadCells(C: number, tallIdx: ReadonlySet<number>, nItems: number): { cells: Cell[]; shortCols: number[] } {
  const cells: Cell[] = [];
  let col = 0;
  for (let k = 0; k < nItems; k++) {
    if (tallIdx.has(k) && col < C) {
      cells.push({ col, row: 0, span: true });
      col++;
    }
  }
  const shortCols: number[] = [];
  for (let c = col; c < C; c++) {
    shortCols.push(c);
    cells.push({ col: c, row: 0 });
    cells.push({ col: c, row: 1 });
  }
  return { cells, shortCols };
}

export function layoutQuads(main: HTMLElement, all: Item[]): void {
  // Hidden sections (a device panel not open yet) take no cell of their own:
  // they ride in the pane of the section before them and show up there.
  const hidden = new Set(all.filter((it) => offsetParentOf(it) === null));
  const items = all.filter((it) => !hidden.has(it));
  if (!items.length) return;
  const n = items.length;
  const { C, T } = quadShape(n);
  const key = 'quads:' + location.pathname + ':' + n;
  const st = readJson(key) as { c?: unknown; r?: unknown } | null;
  let fc: number[] = st && isNumArray(st.c, C) ? st.c : Array<number>(C).fill(1);
  let fr: number[] = st && isNumArray(st.r, 2) ? st.r : [1, 1];
  const save = (): void => {
    try {
      localStorage.setItem(key, JSON.stringify({ c: fc, r: fr }));
    } catch {
      /* blocked storage */
    }
  };
  const grid = document.createElement('div');
  grid.className = 'quads';
  const apply = (): void => {
    grid.style.gridTemplateColumns = tracks(fc);
    grid.style.gridTemplateRows = tracks(fr);
  };
  apply();
  // Which sections stand tall: maps and canvases first, then the longest.
  const weight = (it: Item): number => (it.querySelector('canvas') ? 1e6 : 0) + (it.scrollHeight || offsetHeightOf(it) || 0);
  const tall = new Set(
    items
      .map((it, k): [number, number] => [weight(it), k])
      .sort((x, y) => y[0] - x[0])
      .slice(0, T)
      .map((x) => x[1]),
  );
  const { cells, shortCols } = quadCells(C, tall, n);
  const panes = cells.map((c, k) => {
    const p = document.createElement('div');
    p.className = 'pane';
    p.dataset.q = String(k + 1);
    p.style.setProperty('--qc', COLORS[k % 8] ?? null);
    p.style.gridColumn = String(c.col * 2 + 1);
    p.style.gridRow = c.span ? '1 / span 3' : String(c.row * 2 + 1);
    grid.appendChild(p);
    return p;
  });
  for (let i = 0; i < C - 1; i++) {
    const sh = document.createElement('div');
    sh.className = 'sash v';
    sh.dataset.i = String(i);
    sh.style.gridColumn = String(i * 2 + 2);
    sh.style.gridRow = '1 / -1';
    grid.appendChild(sh);
  }
  for (const c of shortCols) {
    const sh = document.createElement('div');
    sh.className = 'sash h';
    sh.dataset.c = String(c);
    sh.style.gridRow = '2';
    sh.style.gridColumn = String(c * 2 + 1);
    grid.appendChild(sh);
  }
  const rest = Array.from(main.childNodes);
  main.appendChild(grid);
  // Deal: tall sections to the tall panes, the rest in order to the
  // quadrants; past eight, to the pane with the least in it.
  const plan = TC.colPlan && TC.colPlan.key === key && TC.colPlan.ids.length === all.length ? TC.colPlan.ids : null;
  const ids: number[] = [];
  const load = Array<number>(panes.length).fill(0);
  let nextTall = 0;
  let nextShort = cells.findIndex((c) => !c.span);
  let lastPane = 0;
  let k = -1;
  all.forEach((it, a) => {
    let j: number;
    if (hidden.has(it)) {
      j = plan ? plan[a]! : lastPane;
      panes[Math.min(j, panes.length - 1)]!.appendChild(it);
      ids.push(j);
      return;
    }
    k++;
    if (plan) j = plan[a]!;
    else if (tall.has(k) && nextTall < panes.length && cells[nextTall]?.span) j = nextTall++;
    else if (nextShort >= 0 && nextShort < panes.length && !load[nextShort]) j = nextShort++;
    else {
      j = 0;
      for (let i = 1; i < panes.length; i++) if (load[i]! < load[j]!) j = i;
    }
    // A stale plan could index past the panes; the original threw here too.
    const pane = panes[j];
    if (!pane) throw new TypeError('layoutQuads: no pane ' + j);
    pane.appendChild(it);
    load[j]! += offsetHeightOf(it) || 1;
    ids.push(j);
    lastPane = j;
  });
  TC.colPlan = { key, ids };
  for (const r of rest) {
    if ((r instanceof HTMLElement || r instanceof SVGElement) && !all.includes(r) && !SKIP_TAGS.test(r.tagName)) r.style.display = 'none';
  }
  const paneAtCell = (c: number, r: number): HTMLElement | undefined =>
    panes[cells.findIndex((x) => x.col === c && (x.span || x.row === r))];
  const drag = (sash: HTMLElement, horizontal: boolean, i: number): void =>
    sash.addEventListener('pointerdown', (e) => {
      // Vertical sash i sits between columns i and i+1; horizontal sash i
      // splits short column i (both panes always exist for the sashes built above).
      const a = paneAtCell(i, 0);
      const b = horizontal ? paneAtCell(i, 1) : paneAtCell(i + 1, 0);
      if (!a || !b) return;
      e.preventDefault();
      sash.setPointerCapture(e.pointerId);
      sash.classList.add('drag');
      const arr = horizontal ? fr : fc;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const sa = horizontal ? ra.height : ra.width, sb = horizontal ? rb.height : rb.width;
      const x0 = horizontal ? e.clientY : e.clientX;
      const j = horizontal ? 0 : i;
      const sum = arr[j]! + arr[j + 1]!;
      const move = (ev: PointerEvent): void => {
        const d = (horizontal ? ev.clientY : ev.clientX) - x0;
        const na = Math.max(120, Math.min(sa + sb - 120, sa + d));
        arr[j] = (sum * na) / (sa + sb);
        arr[j + 1] = sum - arr[j]!;
        apply();
        resized();
      };
      const up = (): void => {
        sash.classList.remove('drag');
        sash.removeEventListener('pointermove', move);
        sash.removeEventListener('pointerup', up);
        save();
      };
      sash.addEventListener('pointermove', move);
      sash.addEventListener('pointerup', up);
    });
  grid.querySelectorAll<HTMLElement>('.sash.v').forEach((sh) => drag(sh, false, Number(sh.dataset.i)));
  grid.querySelectorAll<HTMLElement>('.sash.h').forEach((sh) => drag(sh, true, Number(sh.dataset.c)));
  grid.querySelectorAll('.sash').forEach((sh) =>
    sh.addEventListener('dblclick', () => {
      // Reassigning (not mutating) matches the original: live drags keep the old arrays.
      fc = Array<number>(C).fill(1);
      fr = [1, 1];
      apply();
      try {
        localStorage.removeItem(key);
      } catch {
        /* blocked storage */
      }
      resized();
    }),
  );
  resized();
}

/** The layout switch in the header (▦ / ▥), and Q on the keyboard. Run at DOMContentLoaded. */
export function installLayoutSwitch(): void {
  const nav = document.querySelector('header nav.views');
  if (nav && nav.parentNode && !document.getElementById('quadbtn') && window.innerWidth >= 1200) {
    const b = document.createElement('button');
    b.id = 'quadbtn';
    b.type = 'button';
    b.className = 'small secondary';
    b.title = 'Eight quadrants or columns (Q)';
    b.textContent = quadMode() ? '▦ 8' : '▥ cols';
    b.addEventListener('click', toggleQuads);
    nav.parentNode.insertBefore(b, nav.nextSibling);
  }
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof Element && isTypingTarget(e.target)) return;
    if ((e.key === 'q' || e.key === 'Q') && !e.ctrlKey && !e.metaKey && !e.altKey && window.innerWidth >= 1200) {
      e.preventDefault();
      toggleQuads();
    }
  });
}

/** Sections to deal: direct SECTIONs, or leaf wrappers holding no section; recurse into wrappers that do. */
function collectItems(el: Element, items: Item[]): void {
  for (const c of Array.from(el.children)) {
    if (!(c instanceof HTMLElement || c instanceof SVGElement)) continue; // MathML: never seen in pages
    if (SKIP_TAGS.test(c.tagName) || c.classList.contains('cols')) continue;
    if (c.tagName === 'SECTION' || !c.querySelector('section')) {
      if (offsetParentOf(c) !== null || c.tagName === 'SECTION') items.push(c);
    } else collectItems(c, items);
  }
}

export function layoutCols(): void {
  const main = document.querySelector('main');
  if (!main) return;
  if (POP) {
    applyPop();
    return;
  }
  addPops();
  if (window.innerWidth < 900) return;
  const items: Item[] = [];
  collectItems(main, items);
  if (!items.length) return;
  if (quadMode() && items.length >= 2) {
    layoutQuads(main, items);
    return;
  }
  const n = Math.max(3, Math.min(items.length, Math.floor(main.clientWidth / 560)) || 3);
  const key = 'cols:' + location.pathname + ':' + n;
  const saved = readJson(key);
  let fr: number[] = isNumArray(saved, n) ? saved : Array<number>(n).fill(1);
  const grid = document.createElement('div');
  grid.className = 'cols';
  const cols: HTMLElement[] = [];
  const tmpl = (): string => tracks(fr);
  grid.style.gridTemplateColumns = tmpl();
  for (let i = 0; i < n; i++) {
    if (i) {
      const s = document.createElement('div');
      s.className = 'sash';
      s.dataset.i = String(i - 1);
      grid.appendChild(s);
    }
    const c = document.createElement('div');
    c.className = 'col';
    grid.appendChild(c);
    cols.push(c);
  }
  // Keep what is left behind (scripts, templates) but out of the way.
  const rest = Array.from(main.childNodes);
  main.appendChild(grid);
  const plan = TC.colPlan && TC.colPlan.key === key && TC.colPlan.ids.length === items.length ? TC.colPlan.ids : null;
  const ids: number[] = [];
  items.forEach((it, k) => {
    let j: number;
    if (plan) j = plan[k]!;
    else {
      j = 0;
      for (let i = 1; i < n; i++) if (cols[i]!.scrollHeight < cols[j]!.scrollHeight - 1) j = i;
    }
    const col = cols[j];
    if (!col) throw new TypeError('layoutCols: no column ' + j);
    col.appendChild(it);
    ids.push(j);
  });
  TC.colPlan = { key, ids };
  // The emptied wrappers stay (their scripts may look them up) but hidden.
  for (const r of rest) {
    if ((r instanceof HTMLElement || r instanceof SVGElement) && !items.includes(r) && !SKIP_TAGS.test(r.tagName)) r.style.display = 'none';
  }
  grid.querySelectorAll<HTMLElement>('.sash').forEach((sash) => {
    sash.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      sash.setPointerCapture(e.pointerId);
      sash.classList.add('drag');
      const i = Number(sash.dataset.i);
      const a = cols[i]!, b = cols[i + 1]!; // sash i sits between cols i and i+1
      const wa = a.getBoundingClientRect().width, wb = b.getBoundingClientRect().width, x0 = e.clientX;
      const sum = fr[i]! + fr[i + 1]!;
      const move = (ev: PointerEvent): void => {
        const d = ev.clientX - x0;
        const na = Math.max(120, Math.min(wa + wb - 120, wa + d));
        fr[i] = (sum * na) / (wa + wb);
        fr[i + 1] = sum - fr[i]!;
        grid.style.gridTemplateColumns = tmpl();
        resized();
      };
      const up = (): void => {
        sash.classList.remove('drag');
        sash.removeEventListener('pointermove', move);
        sash.removeEventListener('pointerup', up);
        try {
          localStorage.setItem(key, JSON.stringify(fr));
        } catch {
          /* blocked storage */
        }
      };
      sash.addEventListener('pointermove', move);
      sash.addEventListener('pointerup', up);
    });
    sash.addEventListener('dblclick', () => {
      fr = Array<number>(n).fill(1);
      grid.style.gridTemplateColumns = tmpl();
      try {
        localStorage.removeItem(key);
      } catch {
        /* blocked storage */
      }
      resized();
    });
  });
  resized();
}
