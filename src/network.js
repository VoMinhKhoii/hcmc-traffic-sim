// network.js — static map data matching the team's hand-drawn HCMC map
// (Phú Nhuận). Topology traced from the map:
//
//   I3 ───────────R1 (Ng.Văn Trỗi)──────✕rail─── I5
//   │R5                                          │
//   I1 ───────R3 (Ng.Trọng Tuyển)───✕rail─────── I6   R2 (Trần Huy Liệu)
//   │R5                                          │      runs I5→I6→I4
//   I2 ────────R4 (diagonal)───✕rail──────────── I4
//
// Railway (North–South line, along Lê Văn Sỹ) crosses R1 near I5 (A),
// R3 east of I1 (C), and R4 near I2 (B).

// Canvas coordinates in the hand-drawn map's proportions (spread out, not compact).
export const INTERSECTIONS = {
  I3: { x: 180, y: 120 },
  I5: { x: 860, y: 170 },
  I1: { x: 175, y: 400 },
  I2: { x: 170, y: 510 },
  I6: { x: 850, y: 480 },
  I4: { x: 950, y: 860 },
};

// Streets (best-effort naming from the map; lengths approximate, tunable).
export const ROADS = {
  R1: 'Nguyễn Văn Trỗi',
  R2: 'Trần Huy Liệu',
  R3: 'Nguyễn Trọng Tuyển',
  R4: '(diagonal to Duy Tân)',
  R5: '(west side street)',
};

export const LINKS = [
  { id: 'I3-I5', a: 'I3', b: 'I5', road: 'R1', len: 430, crossing: { name: 'A', near: 'I5', dist: 110 } },
  { id: 'I3-I1', a: 'I3', b: 'I1', road: 'R5', len: 350 },
  { id: 'I1-I6', a: 'I1', b: 'I6', road: 'R3', len: 450 },
  { id: 'I5-I6', a: 'I5', b: 'I6', road: 'R2', len: 300 },
  { id: 'I6-I4', a: 'I6', b: 'I4', road: 'R2', len: 330 },
  { id: 'I1-I2', a: 'I1', b: 'I2', road: 'R5', len: 120 },
  { id: 'I2-I4', a: 'I2', b: 'I4', road: 'R4', len: 520, crossing: { name: 'B', near: 'I2', dist: 110 } },
];

// Each intersection is 4-way: approaches N/E/S/W.
//   { link: 'I3-I5' }        → internal: fed by the other end of that link
//   { ext: 'main'|'side' }   → boundary approach, Poisson arrivals by class
// Road classes: R1 (Ng.Văn Trỗi) and R2 (Trần Huy Liệu) = main; R3/R4/R5 = side.
// Phase A serves E+W, phase B serves N+S (concurrent pedestrian walks).
// The I2–I4 diagonal is compass-mapped: S at I2, W at I4.
export const APPROACHES = {
  I3: { N: { ext: 'side' }, E: { link: 'I3-I5' }, S: { link: 'I3-I1' }, W: { ext: 'main' } },
  I5: { N: { ext: 'main' }, E: { ext: 'main' }, S: { link: 'I5-I6' }, W: { link: 'I3-I5' } },
  I1: { N: { link: 'I3-I1' }, E: { link: 'I1-I6' }, S: { link: 'I1-I2' }, W: { ext: 'side' } },
  I2: { N: { link: 'I1-I2' }, E: { ext: 'side' }, S: { link: 'I2-I4' }, W: { ext: 'side' } },
  I6: { N: { link: 'I5-I6' }, E: { ext: 'side' }, S: { link: 'I6-I4' }, W: { link: 'I1-I6' } },
  I4: { N: { link: 'I6-I4' }, E: { ext: 'side' }, S: { ext: 'main' }, W: { link: 'I2-I4' } },
};

// Which phase serves which approaches, and each intersection's "main" phase
// (flashing yellow at night; the other flashes red).
export const PHASES = { A: ['E', 'W'], B: ['N', 'S'] };
export const MAIN_PHASE = { I3: 'A', I5: 'A', I1: 'A', I2: 'B', I6: 'B', I4: 'B' };

// Railway crossings: which intersection preempts, and which of its approaches
// is the "pocket" (queue between stop line and tracks that can spill back).
// Crossing A: on R1 110 m west of I5 → I5's W approach is the pocket.
// Crossing B: on the diagonal 110 m from I2 → I2's S approach is the pocket.
// Crossing C is computed analytically: intersect segment I1–I6 with the
// infinite rail line through the already-defined A and B crossing points.
const crossingA = {
  link: 'I3-I5', intersection: 'I5', pocketApproach: 'W',
  pos: frac('I3-I5', 'I5', 110), pocketLength: 110,
};
const crossingB = {
  link: 'I2-I4', intersection: 'I2', pocketApproach: 'S',
  pos: frac('I2-I4', 'I2', 110), pocketLength: 110,
};
const crossingCPos = railIntersectionFraction(crossingA, crossingB, 'I1-I6');
const crossingC = {
  link: 'I1-I6', intersection: 'I1', pocketApproach: 'E',
  pos: crossingCPos, pocketLength: linkById('I1-I6').len * crossingCPos,
};

export const CROSSINGS = { A: crossingA, B: crossingB, C: crossingC };

// Link metadata drives pipe/gate construction. C's marker uses the same
// analytically derived distance as its safety pocket rather than an estimate.
linkById('I1-I6').crossing = {
  name: 'C', near: 'I1', dist: crossingC.pocketLength,
};

function frac(linkId, near, dist) {
  const l = LINKS.find((x) => x.id === linkId);
  return near === l.a ? dist / l.len : 1 - dist / l.len;
}

function crossingPoint(c) {
  const l = linkById(c.link), a = INTERSECTIONS[l.a], b = INTERSECTIONS[l.b];
  return { x: a.x + (b.x - a.x) * c.pos, y: a.y + (b.y - a.y) * c.pos };
}

function railIntersectionFraction(first, second, roadLinkId) {
  const p = crossingPoint(first), q = crossingPoint(second);
  const road = linkById(roadLinkId);
  const r = INTERSECTIONS[road.a], s = INTERSECTIONS[road.b];
  const rail = { x: q.x - p.x, y: q.y - p.y };
  const street = { x: s.x - r.x, y: s.y - r.y };
  const fromRail = { x: r.x - p.x, y: r.y - p.y };
  const cross = (u, v) => u.x * v.y - u.y * v.x;
  const denominator = cross(rail, street);
  if (Math.abs(denominator) < 1e-12) throw new Error(`rail is parallel to ${roadLinkId}`);
  const pos = cross(fromRail, rail) / denominator;
  if (pos < 0 || pos > 1) throw new Error(`rail misses segment ${roadLinkId}`);
  return pos;
}

export const OPPOSITE = { N: 'S', S: 'N', E: 'W', W: 'E' };
export const DIRS = ['N', 'E', 'S', 'W'];

export function linkById(id) { return LINKS.find((l) => l.id === id); }

// For approach `dir` at `node`: where do straight-through vehicles go?
// They exit via the opposite side — internal link (with delay) or out of network.
export function throughTarget(node, dir) {
  const out = APPROACHES[node][OPPOSITE[dir]];
  if (out.link) {
    const l = linkById(out.link);
    return { type: 'link', link: out.link, to: l.a === node ? l.b : l.a };
  }
  return { type: 'exit' };
}

// Class of an approach: main-road or side-road (drives λ and flash pattern).
export function approachClass(node, dir) {
  const ap = APPROACHES[node][dir];
  if (ap.ext) return ap.ext;
  const road = linkById(ap.link).road;
  return road === 'R1' || road === 'R2' ? 'main' : 'side';
}

// Unit vector pointing OUT of `node` along the road that carries approach
// `dir` — the ACTUAL geometry (diagonal for diagonal links), falling back to
// the compass direction for external stubs. Renderers must use this, not the
// compass, so approach furniture lines up with the drawn road.
export function approachVector(node, dir) {
  const ap = APPROACHES[node][dir];
  if (ap.link) {
    const l = linkById(ap.link);
    const p = INTERSECTIONS[node], o = INTERSECTIONS[l.a === node ? l.b : l.a];
    const d = Math.hypot(o.x - p.x, o.y - p.y);
    return { x: (o.x - p.x) / d, y: (o.y - p.y) / d };
  }
  return { N: { x: 0, y: -1 }, E: { x: 1, y: 0 }, S: { x: 0, y: 1 }, W: { x: -1, y: 0 } }[dir];
}

// Directed-link travel: which approach does traffic entering `link` at `from` feed?
export function feedsApproach(linkId, from) {
  const l = linkById(linkId);
  const to = l.a === from ? l.b : l.a;
  for (const d of DIRS) {
    const ap = APPROACHES[to][d];
    if (ap.link === linkId) return { node: to, dir: d };
  }
  throw new Error(`no approach for ${linkId} at ${to}`);
}
