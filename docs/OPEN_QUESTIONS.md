# Open questions from design

- Does @vscode/markdown-it-katex install and run against markdown-it 15.0.1 inside a module Worker (no DOM)? If not, E1 writes the 60-line $/$$ rule in worker/math.ts.
- TypeScript 7.0.2 (native tsc) with Vite 8.2.2: confirm vite's TS transform and vitest work with the TS 7 toolchain, otherwise pin TypeScript 5.9.x.
- Chrome behaviour of content-visibility:auto with contain-intrinsic-size:auto and ResizeObserver: verify that skipped (off-screen) mounted blocks keep their last rendered size and emit no spurious resize events, so the height model stays consistent (P8/P10 will expose drift).
- Chrome scroll anchoring when blocks near the viewport change from estimated to measured height: if visible jumps appear in P8, add a compensating scrollTop adjustment in the ResizeObserver callback for blocks above the current top edge.
- Memory go/no-go (P13 < 450 MB): if exceeded, reduce the eviction distance (20H → 10H) and/or the worker LRU budget (64 MB → 32 MB).
- FileSystemFileHandle.isSameEntry cost for docId reuse on open (≤10 async calls) — acceptable, but confirm handles survive structured clone into idb-keyval on the target Chrome version.
- CM6 highlightSelectionMatches and lineWrapping on 10 MB: measure P9 (PageDown x100); if wrapped-line measurement dominates, default lineWrap off for docs > 5 MB.
- Whether print support (window.print of the exported HTML) is wanted in v1; the exportHtml protocol message already covers it.
