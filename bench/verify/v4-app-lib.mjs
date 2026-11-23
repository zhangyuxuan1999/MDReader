// bench/verify/v4-app-lib.mjs — verify-app (0.2.0 stage 2d): small shims so the v2-app-lib helpers also run
// against the 0.1.1 renderer (its preview handle has no elementOfBlock / isLineVisible).
export async function shimBaseline(page) {
  return page.evaluate(() => {
    const pv = window.__mdr.app.preview;
    const added = [];
    if (typeof pv.elementOfBlock !== 'function') {
      pv.elementOfBlock = (id) => pv.el.querySelector(`.md-block[data-id="${id}"]`);
      added.push('elementOfBlock');
    }
    if (typeof pv.isLineVisible !== 'function') {
      pv.isLineVisible = (line) => {
        const b = pv.blockAtLine(line);
        const el = b && pv.el.querySelector(`.md-block[data-id="${b.id}"]`);
        if (!el) return false;
        const r = el.getBoundingClientRect(), box = pv.el.getBoundingClientRect();
        return r.bottom > box.top && r.top < box.bottom;
      };
      added.push('isLineVisible');
    }
    return added;
  });
}
