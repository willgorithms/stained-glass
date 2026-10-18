# Stained Glass Pattern Tool

A browser tool that turns a colored stained-glass pattern PNG into everything
you need to build the piece:

- **Numbered glass pieces** detected from the artwork, with a glass color palette
- **A tiled, print-ready pattern PDF** — true-size pages with overlap, dashed
  trim lines, and split-circle registration marks across seams
- **3D-printable guide plates** (SVG + STL): shrunk piece outlines packed onto
  your print bed, so you can assemble glass over a physical template
- **Printer calibration**: photograph a printed reference page plus a printed
  bar to compute the exact print scale that compensates for your paper and 3D
  printers' dimensional error

Everything runs locally in the browser — no upload, no server.

## Using the app

1. Drop a pattern PNG on the landing page (or browse for one). Black lines
   should separate the colored regions.
2. Set the **finished piece size** — the real-world dimensions of the panel.
3. Tune the paper pattern (page size, overlap, printer margin, scale) and
   guide plate settings (bed size, clearance corner for printer clips, guide
   height, shrink allowance for copper foil).
4. Click pieces in the preview — or swatches in the palette — to exclude them
   from the plates.
5. Download `pattern.pdf` to print and tile, plus one `plate-N.svg` /
   `plate-N.stl` per guide plate for your slicer.

Settings persist per pattern in `localStorage`, keyed by the image's content
hash — reloading the same PNG restores your adjustments.

## Development

```sh
npm install
npm run dev      # vite dev server
npm run test     # vitest unit + e2e suite
npm run build    # typecheck + production build to dist/
```

### Layout

- `src/detect.ts` — PNG → piece segmentation (line-color detection,
  voronoi expansion to line centers, boundary tracing)
- `src/pipeline.ts` — detection → mm-space pieces, filtering, palette clustering
- `src/pack.ts` — shelf packing of guide pieces onto plates
- `src/out-pdf.ts` / `out-svg.ts` / `out-stl.ts` — pattern PDF, plate SVG, plate STL
- `src/calibrate.ts` — calibration artifacts + photo analysis (homography,
  PCA-based measurement)
- `src/settings.ts` — per-pattern settings in localStorage
- `src/main.ts` — UI wiring, canvas previews, downloads
- `tests/` — vitest suite; `tests/fixtures/` holds the sample pattern PNGs the
  e2e regression tests run against
- `scripts/` — dev-only headless utilities (`tsx`); `out/` holds their debug
  renders and is git-ignored

## CI & deployment

- **`Tests`** runs `vitest` plus a typecheck/build on every PR and push to `main`.
- **`Deploy to GitHub Pages`** builds `dist/` and publishes it on every push
  to `main`.

To enable Pages: **Settings → Pages → Source → "GitHub Actions"**. The build
uses relative asset paths (`base: './'`), so the site works at whatever path
it lands on — `user.github.io/<repo>/`, a custom domain, or a project rename —
without config changes.

## Pipeline notes

Detection treats pixels near the darkest color as line work and everything
else as piece interior; piece regions then grow into the lines via voronoi
expansion so traced boundaries sit on line centers. Guide outlines are eroded
inward ("guide shrink") to leave room for copper foil. The STL flips Y so the
plate matches the pattern top-down. Piece settings (exclusions, sizes) key off
content signatures rather than ids, so renumbering doesn't lose your choices.
