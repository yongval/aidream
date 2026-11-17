"use strict";
/*
  THE LIBRARY THAT DREAMS — Open Library live API edition

  This file has four cooperating parts:
  1. Load and normalize book records from Open Library.
  2. Build a reusable graph of square tiles in the Poincare disk.
  3. Project the hyperbolic geometry onto the browser's 2D canvas.
  4. Move the view in response to dragging, scrolling, or arrow keys.

  The Poincare disk is a model of hyperbolic space. Its boundary represents
  points infinitely far away; hyperbolic straight lines appear as circular
  arcs that meet the disk boundary at right angles. The project tiles that
  space with squares, then places book-cover images inside the squares.

  The total displayed is Open Library's reported work_count, not the number
  currently fetched. Records are downloaded a page at a time, rather than
  attempting to download the whole catalog at startup.
*/
const canvas = document.getElementById("art");
const ctx = canvas.getContext("2d", { alpha: false });
const loadedNode = document.getElementById("loaded");
const totalNode = document.getElementById("available");
const statusNode = document.getElementById("status");
const counter = document.getElementById("count");
const SUBJECT = "dreams";
const PAGE_SIZE = 100;
const MAX_SESSION_BOOKS = 1000;
const MAX_VISIBLE_COVERS = 120;
const MIN_COVER_RADIUS = 12;
const SESSION_SEED = Math.floor(Math.random() * 0x100000000);
const BOOKS = [];
const bookByKey = new Map();
const coverImages = new Map();
let totalAvailable = null;
let offset = 0;
let fetching = false;
let bootPages = 0;
let navigations = 0;
let lastAttempt = 0;
let fetchError = false;
let hasMore = true;
const numberFormat = new Intl.NumberFormat("en-US");

/*
  The counter has three distinct values to report:
  - BOOKS contains the records actually downloaded in this browser session.
  - totalAvailable is Open Library's estimate for the whole subject.
  - fetching / fetchError / hasMore control the status message and paging.
  bookByKey prevents duplicate works if the API returns overlapping pages.
*/
function updateCount(message = "") {
  loadedNode.textContent = BOOKS.length
    ? numberFormat.format(BOOKS.length)
    : "0";
  totalNode.textContent = Number.isFinite(totalAvailable)
    ? numberFormat.format(totalAvailable)
    : "—";
  counter.dataset.error = fetchError ? "true" : "false";
  statusNode.textContent =
    message ||
    (fetchError
      ? "Connection failed · click to retry"
      : fetching
        ? "Loading books…"
        : BOOKS.length
          ? `Dreams subject · Live data`
          : "Connecting to Open Library…");
}

/*
  Convert an API work into the small, consistent shape used by the renderer.
  Ignore records without a usable title or key, keep at most two author names,
  and provide readable defaults when author/year information is missing.
*/
function normalizeWork(w) {
  if (
    !w ||
    typeof w.title !== "string" ||
    !w.title.trim() ||
    typeof w.key !== "string"
  )
    return null;
  const authors = Array.isArray(w.authors)
    ? w.authors
        .filter((a) => a && typeof a.name === "string")
        .map((a) => a.name.trim())
        .filter(Boolean)
    : [];
  const pubYear = Number.isInteger(w.first_publish_year)
    ? w.first_publish_year
    : null;
  const coverId = Number.isInteger(w.cover_id)
    ? w.cover_id
    : Number.isInteger(w.cover_i)
      ? w.cover_i
      : null;
  if (!coverId || coverId < 1) return null;
  return {
    key: w.key,
    coverId,
    title: w.title.trim(),
    author: authors.slice(0, 2).join(" & ") || "Unknown author",
    year: pubYear ? String(pubYear) : "n.d.",
  };
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/*
  Request one page of books. The offset advances by the number of records
  returned, and a short delay avoids sending rapid consecutive requests.
  The direct Open Library request is preferred; when the site is served over
  HTTP(S), a local /api/dreams endpoint may be tried if the direct request
  fails (for example, because of browser cross-origin restrictions).
  Only a few pages are fetched at startup; later navigation can request more.
*/
async function fetchNextPage() {
  if (fetching || !hasMore || BOOKS.length >= MAX_SESSION_BOOKS) return;
  fetching = true;
  fetchError = false;
  updateCount();
  try {
    const since = Date.now() - lastAttempt;
    if (since < 1200) await sleep(1200 - since);
    lastAttempt = Date.now();
    const url = `https://openlibrary.org/subjects/${SUBJECT}.json?limit=${PAGE_SIZE}&offset=${offset}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 16000);
    let data;
    try {
      try {
        const response = await fetch(url, {
          mode: "cors",
          signal: controller.signal,
        });
        if (!response.ok)
          throw new Error(`Open Library returned ${response.status}`);
        data = await response.json();
      } catch (directError) {
        // Local companion server bypasses browser CORS restrictions safely.
        if (!/^https?:$/.test(window.location.protocol)) throw directError;
        const proxyUrl = `/api/dreams?limit=${PAGE_SIZE}&offset=${offset}`;
        const fallback = await fetch(proxyUrl, { signal: controller.signal });
        if (!fallback.ok) throw directError;
        data = await fallback.json();
      }
    } finally {
      clearTimeout(timeout);
    }
    if (!data || !Array.isArray(data.works))
      throw new Error("Unexpected Open Library response");
    if (Number.isInteger(data.work_count)) totalAvailable = data.work_count;
    for (const w of data.works) {
      const book = normalizeWork(w);
      if (book && !bookByKey.has(book.key)) {
        bookByKey.set(book.key, book);
        BOOKS.push(book);
      }
    }
    offset += data.works.length;
    hasMore =
      data.works.length > 0 &&
      (totalAvailable === null || offset < totalAvailable);
    fetchError = false;
    // Keep existing tile assignments stable while the catalog expands.
    updateCount();
    schedule();
    bootPages++;
    if (bootPages < 3 && hasMore && BOOKS.length < MAX_SESSION_BOOKS) {
      setTimeout(fetchNextPage, 1300);
    }
  } catch (error) {
    console.error("Open Library connection:", error);
    fetchError = true;
    updateCount(
      BOOKS.length
        ? "Live connection interrupted · click to retry"
        : "Connection unavailable · click to retry",
    );
  } finally {
    fetching = false;
    if (!fetchError) updateCount();
  }
}
function browseMoreIfNeeded() {
  navigations++;
  if (
    bootPages >= 3 &&
    navigations % 18 === 0 &&
    !fetching &&
    hasMore &&
    BOOKS.length < MAX_SESSION_BOOKS
  )
    fetchNextPage();
}
counter.addEventListener("click", () => {
  if (fetchError) fetchNextPage();
});

/*
  Geometry below uses ordinary (x, y) coordinates inside the unit disk.
  The helpers implement vector arithmetic; keeping them small makes the
  circle/arc and reflection calculations easier to read.
*/
const PAPER = "#050609";
const PI = Math.PI,
  TAU = PI * 2;
const V = (x, y) => ({ x, y });
const sq = (z) => z.x * z.x + z.y * z.y;
const add = (a, b) => V(a.x + b.x, a.y + b.y);
const sub = (a, b) => V(a.x - b.x, a.y - b.y);
const mul = (a, k) => V(a.x * k, a.y * k);
const cross = (a, b) => a.x * b.y - a.y * b.x;
const EPS = 1e-12;

/*
  In the Poincare disk, a hyperbolic straight line (a geodesic) is either:
  - a Euclidean circle that intersects the unit circle at 90 degrees, or
  - a diameter of the unit circle.

  For a circle with center c and radius r, perpendicular intersection with
  the unit circle implies r^2 = |c|^2 - 1. Solving this circle equation for
  the center gives the formula below. A near-zero determinant means the two
  points lie on a diameter, so the function returns null for that case.
*/
function geodesic(a, b) {
  const det = cross(a, b);
  if (Math.abs(det) < EPS) return null; // a diameter
  const va = (1 + sq(a)) * 0.5,
    vb = (1 + sq(b)) * 0.5;
  const c = V((va * b.y - vb * a.y) / det, (a.x * vb - b.x * va) / det);
  return { c, r2: sq(c) - 1 };
}

/*
  Reflect a point across the geodesic through a and b. For a diameter, this
  is ordinary reflection across a line. For a circular geodesic, inversion
  in that circle gives the hyperbolic reflection. The returned function can
  be applied to every corner and center of a tile.
*/
function reflectAcross(a, b) {
  const g = geodesic(a, b);
  if (!g) {
    const base = sq(a) > 1e-18 ? a : b;
    const unit = mul(base, 1 / Math.sqrt(sq(base)));
    return (z) => sub(mul(unit, 2 * (unit.x * z.x + unit.y * z.y)), z);
  }
  return (z) => {
    const d = sub(z, g.c);
    return add(g.c, mul(d, g.r2 / sq(d)));
  };
}

/*
  Hyperbolic translation in the disk. In complex-number notation this is
  (z + a) / (1 + conjugate(a) * z), written out with real x/y arithmetic.
  It moves the view while preserving hyperbolic shapes and angles; unlike
  adding a pixel offset, it correctly carries the pattern through the disk.
*/
function diskTranslate(z, a) {
  // (z+a)/(1+conj(a)*z) — hyperbolic isometry.
  const numer = add(z, a);
  const u = 1 + a.x * z.x + a.y * z.y;
  const v = a.x * z.y - a.y * z.x;
  const d = u * u + v * v;
  return V((numer.x * u + numer.y * v) / d, (numer.y * u - numer.x * v) / d);
}
function transformGeom(g, a) {
  return {
    corners: g.corners.map((z) => diskTranslate(z, a)),
    center: diskTranslate(g.center, a),
  };
}

/*
  Reflections and translations can calculate the same tile by different
  paths, producing tiny floating-point differences. key() rounds a center
  for Map lookup, while samePoint() uses a distance tolerance when matching
  corners. permutationOf() identifies how corner indexes correspond between
  two representations of the same tile.
*/
function key(z) {
  return `${z.x.toFixed(7)}:${z.y.toFixed(7)}`;
}
function samePoint(a, b) {
  return sq(sub(a, b)) < 8e-11;
}
function permutationOf(raw, target) {
  const perm = [];
  for (const v of target) {
    const idx = raw.findIndex((x) => samePoint(x, v));
    if (idx < 0) return null;
    perm.push(idx);
  }
  return new Set(perm).size === 4 ? perm : null;
}
function sideAt(corners, ptA, ptB) {
  for (let j = 0; j < 4; j++) {
    const x = corners[j],
      y = corners[(j + 1) % 4];
    if (
      (samePoint(x, ptA) && samePoint(y, ptB)) ||
      (samePoint(x, ptB) && samePoint(y, ptA))
    )
      return j;
  }
  return -1;
}
function reflectGeom(geom, side) {
  const r = reflectAcross(geom.corners[side], geom.corners[(side + 1) % 4]);
  return { corners: geom.corners.map(r), center: r(geom.center) };
}
function applyPermutation(g, p) {
  return { corners: p.map((j) => g.corners[j]), center: g.center };
}

/*
  Start with one regular hyperbolic square centered at the origin. rho is the
  distance from its center to each vertex for the {4,5} tiling: four sides
  meet at each square corner and five squares fit around each disk vertex.
  The tile has a stable ID and four neighbor links, one for each side.
*/
const rho = Math.tanh(
  Math.acosh(1 / (Math.tan(PI / 4) * Math.tan(PI / 5))) / 2,
);
const seedGeom = {
  corners: Array.from({ length: 4 }, (_, j) =>
    V(
      rho * Math.cos(PI / 4 + (j * TAU) / 4),
      rho * Math.sin(PI / 4 + (j * TAU) / 4),
    ),
  ),
  center: V(0, 0),
};
let nextId = 0;
function newTile() {
  return { id: nextId++, links: [null, null, null, null], bookKey: null };
}
let anchorTile = newTile();
let anchorGeom = seedGeom;
let view = [];
let viewByTile = new Map();
let painted = [];
let hovered = null;
let width = 0,
  height = 0,
  radius = 1,
  cx = 0,
  cy = 0,
  dpr = 1;
let pending = false;
const MAX_VIEW_TILES = 1800;
const MAX_CENTER_R = 0.992;

/*
  The tile graph stores topology (which tile is next to which), separately
  from geometry (where each tile currently appears in the disk). A link also
  stores the neighbor's matching side and corner-index permutation, so the
  same tile keeps its identity as the visible region is rebuilt while panning.
*/
function connectTile(tile, side, g, raw, existing, existingGeom) {
  const forward = permutationOf(raw.corners, existingGeom.corners);
  if (!forward) return false;
  const backSide = sideAt(
    existingGeom.corners,
    g.corners[side],
    g.corners[(side + 1) % 4],
  );
  if (backSide < 0) return false;
  const reverse = permutationOf(
    reflectGeom(existingGeom, backSide).corners,
    g.corners,
  );
  if (!reverse) return false;
  tile.links[side] = { node: existing, side: backSide, perm: forward };
  existing.links[backSide] = { node: tile, side, perm: reverse };
  return true;
}

/*
  Find the tile across one side. Reflecting the current geometry gives the
  expected neighbor. If this tile already has a graph link, reuse that ID;
  otherwise, reuse a tile already discovered at this position or create a
  new graph node. This prevents a tile reached by two routes from becoming
  two different tiles in the book library.
*/
function ensureNeighbor(tile, geom, side, discovered) {
  const raw = reflectGeom(geom, side);
  const l = tile.links[side];
  if (l) {
    return { tile: l.node, geom: applyPermutation(raw, l.perm) };
  }
  const match = discovered.get(key(raw.center));
  if (match) {
    if (!connectTile(tile, side, geom, raw, match.tile, match.geom))
      return null;
    return { tile: match.tile, geom: match.geom };
  }
  const next = newTile();
  // Reflected vertex indices have the same common side indices.
  tile.links[side] = { node: next, side, perm: [0, 1, 2, 3] };
  next.links[side] = { node: tile, side, perm: [0, 1, 2, 3] };
  return { tile: next, geom: raw };
}

/*
  Rebuild only the region needed for the current screen:
  - Start at the anchor tile.
  - Visit neighboring tiles breadth-first (near tiles first).
  - Ignore tiles whose centers are too close to the disk boundary.
  - Stop at MAX_VIEW_TILES to bound work and memory per rebuild.

  `discovered` maps rounded geometric centers to the first tile found there;
  `seenTiles` stops the traversal from adding the same graph node twice.
  The resulting `view` is the geometry rendered in the next frame, and
  viewByTile makes it quick to test whether a tile's neighbor is also visible.
*/
function rebuildView() {
  const initial = { tile: anchorTile, geom: anchorGeom };
  const discovered = new Map([[key(anchorGeom.center), initial]]);
  const seenTiles = new Set([anchorTile.id]);
  const q = [initial];
  let head = 0;
  for (; head < q.length && q.length < MAX_VIEW_TILES; head++) {
    const current = q[head];
    for (let side = 0; side < 4; side++) {
      // Never allocate graph nodes that are outside this local render window.
      const candidate = reflectGeom(current.geom, side);
      if (sq(candidate.center) > MAX_CENTER_R * MAX_CENTER_R) continue;
      const near = ensureNeighbor(current.tile, current.geom, side, discovered);
      if (!near) continue;
      if (sq(near.geom.center) > MAX_CENTER_R * MAX_CENTER_R) continue;
      const k = key(near.geom.center);
      if (seenTiles.has(near.tile.id)) continue;
      if (discovered.has(k)) {
        const prior = discovered.get(k);
        // Converging paths must identify the very same square.
        if (prior.tile !== near.tile) {
          connectTile(
            current.tile,
            side,
            current.geom,
            reflectGeom(current.geom, side),
            prior.tile,
            prior.geom,
          );
        }
        continue;
      }
      const entry = { tile: near.tile, geom: near.geom };
      discovered.set(k, entry);
      seenTiles.add(near.tile.id);
      q.push(entry);
      if (q.length >= MAX_VIEW_TILES) break;
    }
  }
  view = q;
  viewByTile = new Map(q.map((x) => [x.tile.id, x]));
  window.__libraryStats = {
    visible: view.length,
    totalCells: nextId,
    center: anchorTile.id,
    loadedBooks: BOOKS.length,
    availableBooks: totalAvailable,
  };
}

/*
  Recenter the local coordinate frame when the anchor drifts far from the
  disk's center. Choosing the currently visible tile nearest the origin
  avoids continually transforming very distant coordinates and gives the
  next view rebuild a well-conditioned starting point.
*/
function recenterView() {
  if (sq(anchorGeom.center) < 0.2) return;
  let choice = null,
    best = Infinity;
  for (const x of view) {
    const d = sq(x.geom.center);
    if (d < best) {
      choice = x;
      best = d;
    }
  }
  if (choice) {
    anchorTile = choice.tile;
    anchorGeom = choice.geom;
  }
}

/*
  Convert a user drag/scroll distance in pixels into a hyperbolic movement.
  Large movements are split into smaller translations to avoid one large
  step becoming numerically unstable. Apply each step to the anchor and all
  currently visible tiles, then recenter, rebuild the surrounding tile set,
  optionally load more book records, and request a redraw.
*/
function panByPixels(dx, dy) {
  if (!radius) return;
  const d = Math.hypot(dx, dy);
  // Split large trackpad wheel events into short isometries.
  const steps = Math.max(1, Math.ceil(d / (radius * 0.18)));
  const a = V((dx * 0.72) / (radius * steps), (dy * 0.72) / (radius * steps));
  for (let i = 0; i < steps; i++) {
    anchorGeom = transformGeom(anchorGeom, a);
    for (const entry of view) entry.geom = transformGeom(entry.geom, a);
    recenterView();
  }
  rebuildView();
  browseMoreIfNeeded();
  schedule();
}

/*
  Keep the canvas sharp on high-density screens: its backing bitmap uses the
  device-pixel ratio, while drawing coordinates remain in CSS pixels. The
  disk radius is set from the smaller viewport dimension so the circle fits.
*/
function resize() {
  width = window.innerWidth;
  height = window.innerHeight;
  dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  radius = Math.min(width, height) * 0.488;
  cx = width / 2;
  cy = height / 2;
  schedule();
}
const screen = (z) => V(cx + z.x * radius, cy + z.y * radius);

/*
  Draw one hyperbolic straight edge. A diameter is drawn as a line; other
  geodesics are circular arcs. Angles are reduced to the shorter arc between
  the two endpoints, which is the segment belonging to the tile side.
*/
function edge(a, b, separateArcStart = false) {
  const g = geodesic(a, b);
  if (!g) {
    const sa = screen(a),
      sb = screen(b);
    if (separateArcStart) ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    return;
  }
  const center = screen(g.c);
  const r = radius * Math.sqrt(g.r2);
  const sa = Math.atan2(a.y - g.c.y, a.x - g.c.x);
  const sb = Math.atan2(b.y - g.c.y, b.x - g.c.x);
  let delta = sb - sa;
  while (delta > PI) delta -= TAU;
  while (delta < -PI) delta += TAU;
  if (!Number.isFinite(r) || r > 1e8) {
    const x = screen(a),
      y = screen(b);
    if (separateArcStart) ctx.moveTo(x.x, x.y);
    ctx.lineTo(y.x, y.y);
    return;
  }
  if (separateArcStart) {
    ctx.moveTo(center.x + r * Math.cos(sa), center.y + r * Math.sin(sa));
  }
  ctx.arc(center.x, center.y, r, sa, sa + delta, delta < 0);
}

/*
  A tile's ID and this page-load seed choose its book. bookKey caches the
  choice so loading another API page does not change the current arrangement.
*/
function stableBookIndex(id) {
  if (!BOOKS.length) return -1;
  let h = (id ^ 0x9e3779b9 ^ SESSION_SEED) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) % BOOKS.length;
}
function bookForTile(tile) {
  if (!BOOKS.length) return null;
  if (tile.bookKey && bookByKey.has(tile.bookKey))
    return bookByKey.get(tile.bookKey);
  const book = BOOKS[stableBookIndex(tile.id)];
  tile.bookKey = book.key;
  return book;
}

function coverImageFor(book) {
  if (!coverImages.has(book.coverId)) {
    const image = new Image();
    image.decoding = "async";
    coverImages.set(book.coverId, image);
    image.onload = schedule;
    image.onerror = () => {
      coverImages.set(book.coverId, null);
      console.warn(`Book cover ${book.coverId} could not be loaded.`);
    };
    image.src = `https://covers.openlibrary.org/b/id/${book.coverId}-M.jpg`;
  }
  const image = coverImages.get(book.coverId);
  return image?.complete && image.naturalWidth > 0 ? image : null;
}

/* Draw one softly edged cover above the connecting web. */
function drawBookCover({ tile, book, center, r }) {
  const image = coverImageFor(book);
  if (!image) return;
  const imageHeight = Math.min(r * 1.5, 176);
  const imageWidth = Math.min(
    imageHeight * (image.naturalWidth / image.naturalHeight),
    r * 1.45,
  );
  const rotation = (((tile.id * 37) % 9) - 4) * 0.009;
  ctx.save();
  ctx.translate(center.x, center.y);
  ctx.rotate(rotation);
  ctx.drawImage(image, -imageWidth / 2, -imageHeight / 2, imageWidth, imageHeight);
  const labelFontSize = Math.max(6.5, Math.min(9.5, r * 0.13));
  const label = `${book.title}, ${book.author}`;
  const maxLabelWidth = Math.min(Math.max(imageWidth * 1.8, 160), 380);
  const baseFont = `${labelFontSize}px ui-monospace, Consolas, monospace`;
  ctx.font = baseFont;
  const measuredWidth = ctx.measureText(label).width;
  const fontSize = Math.max(
    5.5,
    Math.min(
      labelFontSize,
      (maxLabelWidth / Math.max(measuredWidth, 1)) * labelFontSize,
    ),
  );
  const labelFont = `${fontSize}px ui-monospace, Consolas, monospace`;
  const labelX = -imageWidth * 0.38;
  const labelY = imageHeight * 0.38;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = labelFont;
  ctx.fillStyle = "#ffffff";
  ctx.shadowColor = "rgba(0, 0, 0, 0.72)";
  ctx.shadowBlur = 2;
  ctx.shadowOffsetY = 1;
  ctx.fillText(label, labelX, labelY + fontSize);
  ctx.restore();
}

/*
  Paint one complete frame in layers:
  1. Clear the browser viewport to the page background.
  2. Draw thin geodesic connectors between neighboring book centers.
  3. Float available book-cover images above the web of connections.
*/
function render() {
  pending = false;
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, TAU);
  ctx.clip();
  const centers = new Map(view.map((entry) => [entry.tile.id, entry.geom.center]));
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  for (const entry of view) {
    for (const link of entry.tile.links) {
      const neighbor = link?.node;
      if (!neighbor || !centers.has(neighbor.id) || entry.tile.id > neighbor.id)
        continue;
      edge(centers.get(entry.tile.id), centers.get(neighbor.id), true);
    }
  }
  ctx.save();
  ctx.filter = "blur(1.4px)";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx.lineWidth = 0.5;
  ctx.stroke();
  ctx.filter = "none";
  ctx.strokeStyle = "rgb(255, 255, 255)";
  ctx.lineWidth = 0.25;
  ctx.stroke();
  ctx.restore();
  const covers = [];
  for (const entry of view) {
    if (sq(entry.geom.center) > 0.993 * 0.993) continue;
    const book = bookForTile(entry.tile);
    if (!book) continue;
    const center = screen(entry.geom.center);
    let r = Infinity;
    for (const corner of entry.geom.corners) {
      const point = screen(corner);
      r = Math.min(r, Math.hypot(center.x - point.x, center.y - point.y));
    }
    r *= 0.7;
    if (r >= MIN_COVER_RADIUS) covers.push({ ...entry, book, center, r });
  }
  covers.sort((a, b) => b.r - a.r);
  for (const cover of covers.slice(0, MAX_VISIBLE_COVERS))
    drawBookCover(cover);
  const edgeFade = ctx.createRadialGradient(
    cx,
    cy,
    radius * 0.8,
    cx,
    cy,
    radius,
  );
  edgeFade.addColorStop(0, "rgba(5, 6, 9, 0)");
  edgeFade.addColorStop(0.45, "rgba(5, 6, 9, 0.12)");
  edgeFade.addColorStop(0.78, "rgba(5, 6, 9, 0.48)");
  edgeFade.addColorStop(1, "rgba(5, 6, 9, 0.96)");
  ctx.fillStyle = edgeFade;
  ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
  ctx.restore();
}
function schedule() {
  if (!pending) {
    pending = true;
    requestAnimationFrame(render);
  }
}

/*
  requestAnimationFrame batches rapid input into at most one canvas redraw per
  browser frame. `pending` prevents multiple events in the same frame from
  queueing redundant renders.
*/

/* Trackpad two-finger scroll / mouse wheel: pan the library through the disk. */
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const scale =
      e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? Math.min(width, height) : 1;
    const dx = Math.max(-290, Math.min(290, e.deltaX * scale));
    const dy = Math.max(-290, Math.min(290, e.deltaY * scale));
    panByPixels(-dx, -dy);
  },
  { passive: false },
);

/*
  Pointer events cover mouse, pen, and touch with one implementation. Keep
  each active pointer's previous position; a single pointer pans by its delta.
  Pointer capture keeps drag events arriving even if the pointer leaves canvas.
*/
const pointers = new Map();
canvas.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "mouse" && e.button !== 0) return;
  pointers.set(e.pointerId, V(e.clientX, e.clientY));
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId)) return;
  const previous = pointers.get(e.pointerId);
  const now = V(e.clientX, e.clientY);
  pointers.set(e.pointerId, now);
  if (pointers.size === 1) panByPixels(now.x - previous.x, now.y - previous.y);
});
function endPointer(e) {
  pointers.delete(e.pointerId);
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);

/* Arrow keys move by a fixed screen-space distance, using the same pan logic. */
window.addEventListener("keydown", (e) => {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key))
    return;
  e.preventDefault();
  const d = 75;
  panByPixels(
    e.key === "ArrowRight" ? -d : e.key === "ArrowLeft" ? d : 0,
    e.key === "ArrowDown" ? -d : e.key === "ArrowUp" ? d : 0,
  );
});

/* Recalculate the canvas size whenever the browser window changes size. */
window.addEventListener("resize", resize);

/* Build and draw the first view, then begin asynchronously loading books. */
rebuildView();
resize();
updateCount();
fetchNextPage();
