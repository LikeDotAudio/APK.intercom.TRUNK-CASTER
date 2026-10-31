// Racks page (html.rs racks_page): open or hover a rack and only its
// protocol's frames stay bright on the map (window.GLOBE_FILTER, read by the
// map engine, agent 02). Port of the format!-built `<script>` block.

(function () {
  // LATENT (preserved): the .rack NodeList is captured once. Racks refreshes
  // <main> every 5 s without re-running this script, so after the first
  // refresh hover/toggle stop filtering (only TC.onMain's apply(null) still
  // runs, against the fresh DOM). Fix: delegate from document — HANDOFF.md.
  const racks = document.querySelectorAll<HTMLElement>('.rack');
  const open = (): Set<string> => {
    const s = new Set<string>();
    document.querySelectorAll('.rack details[open]').forEach((d) => {
      const r = d.closest<HTMLElement>('.rack');
      // data-proto is always rendered on .rack; `!` mirrors the original,
      // which would add undefined to the set if it were not.
      if (r) s.add(r.dataset.proto!);
    });
    return s;
  };
  const apply = (hover: string | null | undefined): void => {
    const s = open();
    if (hover) s.add(hover);
    window.GLOBE_FILTER = s;
  };
  racks.forEach((r) => {
    r.addEventListener('mouseenter', () => apply(r.dataset.proto));
    r.addEventListener('mouseleave', () => apply(null));
    r.querySelectorAll('details').forEach((d) => d.addEventListener('toggle', () => apply(null)));
  });
  TC.onMain.push(() => apply(null));
})();
