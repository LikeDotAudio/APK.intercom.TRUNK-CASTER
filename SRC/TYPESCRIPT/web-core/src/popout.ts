// Pop-out: every <section> gets a ↗ button that opens it alone in its own
// live window (?pop=<section title>); that window hides the rest.
import { POP } from './env.ts';

/** A section's key: the text of its <h2>'s first text node (else the whole h2), trimmed. */
export function secKey(s: Element): string {
  const h = s.querySelector('h2');
  if (!h) return '';
  const t = h.firstChild;
  return ((t && t.nodeType === 3 ? t.textContent : h.textContent) ?? '').trim();
}

export function addPops(): void {
  if (POP) return;
  document.querySelectorAll('main section').forEach((s) => {
    const h = s.querySelector('h2');
    if (!h || h.querySelector('.pop')) return;
    const k = secKey(s);
    if (!k) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pop';
    b.title = 'Pop out into its own window';
    b.textContent = '↗';
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const u = new URL(location.href);
      u.search = '';
      u.searchParams.set('pop', k);
      window.open(u.toString(), 'pop ' + location.pathname + ' ' + k, 'popup,width=960,height=720');
    });
    h.appendChild(b);
  });
}

export function applyPop(): void {
  if (POP === null) return; // only called when POP is set
  document.body.classList.add('popped');
  document.title = POP;
  const secs = Array.from(document.querySelectorAll<HTMLElement>('main section'));
  const hit = secs.find((s) => secKey(s) === POP);
  if (!hit) return;
  secs.forEach((s) => {
    const show = s === hit || s.contains(hit) || hit.contains(s);
    s.style.display = show ? '' : 'none';
  });
  hit.classList.add('popsel');
}
