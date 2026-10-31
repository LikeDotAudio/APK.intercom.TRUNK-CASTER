// Panel editor page (html.rs panel_editor_page): port of EDITOR_JS.
// These three are called from server-rendered inline handlers
// (oninput="findInTree(this.value)", onsubmit="…renamePort('{id}',{i})",
// onsubmit="…bookPort('{id}',{i})"), so the bundle publishes them on window.

import type { BookingReply } from '../wire.ts';

function bookPort(frame: string, port: number): void {
  const t = (val('bk-start') || '00:00').split(':').map(Number);
  void api('/api/bookings', {
    frame: frame,
    port: port,
    kind: val('bk-kind'),
    program: val('bk-program') || '',
    who: val('bk-who') || null,
    to: val('bk-to') || null,
    start_hour: (t[0] || 0) + (t[1] || 0) / 60,
    minutes: num('bk-min') || 60,
    daily: !!(document.getElementById('bk-daily') as HTMLInputElement | null)?.checked,
  }).then((raw) => {
    // api() yields parsed JSON or raw text; on text, r.id/r.program read
    // undefined exactly as in the original ("booked undefined · undefined").
    const r = raw as BookingReply | null;
    show('bk-result', r && r.error ? r.error : 'booked ' + r!.id + ' · ' + r!.program);
    if (r && !r.error) reload();
  });
}

function renamePort(frame: string, port: number): void {
  const n = val('rn-name');
  if (!n) return;
  void api('/api/rename', { frame: frame, port: port, name: n }).then((raw) => {
    const r = raw as BookingReply | null;
    show('rn-result', r && r.error ? r.error : 'renamed');
    reload();
  });
}

function findInTree(q: string | null | undefined): void {
  q = (q || '').trim().toLowerCase();
  const tree = document.getElementById('ptree');
  if (!tree) return;
  tree.querySelectorAll<HTMLElement>('a.tdev').forEach((a) => {
    a.style.display = !q || a.textContent!.toLowerCase().includes(q) || (a.dataset.where || '').toLowerCase().includes(q) ? '' : 'none';
  });
  tree.querySelectorAll('details').forEach((d) => {
    if (q) {
      d.open = !!Array.from(d.querySelectorAll<HTMLElement>('a.tdev')).find((a) => a.style.display !== 'none');
    }
  });
}

window.bookPort = bookPort;
window.renamePort = renamePort;
window.findInTree = findInTree;
