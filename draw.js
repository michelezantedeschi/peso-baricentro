/* Peso e baricentro – motore di disegno
 * Geometria IFC (web-ifc) -> viste ortogonali con linee nascoste rimosse -> tavola A3 (primitive in mm)
 * -> PDF (jsPDF) e DXF R12.  Nessuna dipendenza dal visualizzatore: funziona anche in Node per i test.
 */
(function (root) {
  'use strict';

  // ------------------------------------------------------------------ IFC
  const IFC = {api: null, models: new Map()};

  async function initIfc(WebIFC, wasmPath) {
    if (IFC.api) return IFC.api;
    const api = new WebIFC.IfcAPI();
    if (wasmPath) api.SetWasmPath(wasmPath, true);
    await api.Init(undefined, true);
    IFC.api = api; IFC.W = WebIFC;
    return api;
  }

  /** Apre un IFC e costruisce la mappa GlobalId -> expressID e la scomposizione degli assiemi */
  function openIfc(key, bytes) {
    const api = IFC.api, W = IFC.W;
    if (IFC.models.has(key)) return IFC.models.get(key);
    const id = api.OpenModel(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), {COORDINATE_TO_ORIGIN: false});
    const g2e = new Map(), ids = api.GetLineIDsWithType(id, W.IFCPRODUCT, true);
    for (let i = 0; i < ids.size(); i++) { const e = ids.get(i); const l = api.GetLine(id, e, false); if (l && l.GlobalId) g2e.set(l.GlobalId.value, e); }
    const kids = new Map(), rels = api.GetLineIDsWithType(id, W.IFCRELAGGREGATES);
    for (let i = 0; i < rels.size(); i++) { const l = api.GetLine(id, rels.get(i), false); const p = l.RelatingObject.value; kids.set(p, (kids.get(p) || []).concat(l.RelatedObjects.map(o => o.value))); }
    const bolts = new Set(); try { const b = api.GetLineIDsWithType(id, W.IFCMECHANICALFASTENER, true); for (let i = 0; i < b.size(); i++) bolts.add(b.get(i)); } catch (e) {}
    const m = {id, g2e, kids, bolts, cache: new Map()};
    IFC.models.set(key, m);
    return m;
  }

  /** Mesh di un elemento in coordinate IFC Z-up (metri), con origine di riferimento ref per la precisione */
  function meshOf(m, eid, ref) {
    ref = m.ref || (m.ref = ref); // un solo punto di riferimento per modello: la cache resta coerente
    if (m.cache.has(eid)) return m.cache.get(eid);
    const api = IFC.api, fm = api.GetFlatMesh(m.id, eid), P = [], I = [];
    for (let k = 0; k < fm.geometries.size(); k++) {
      const pg = fm.geometries.get(k), geo = api.GetGeometry(m.id, pg.geometryExpressID);
      const v = api.GetVertexArray(geo.GetVertexData(), geo.GetVertexDataSize());
      const ix = api.GetIndexArray(geo.GetIndexData(), geo.GetIndexDataSize());
      const T = pg.flatTransformation, base = P.length / 3;
      for (let j = 0; j < v.length; j += 6) {
        const x = v[j], y = v[j + 1], z = v[j + 2];
        const X = T[0] * x + T[4] * y + T[8] * z + T[12], Y = T[1] * x + T[5] * y + T[9] * z + T[13], Z = T[2] * x + T[6] * y + T[10] * z + T[14];
        P.push(X - ref[0], -Z - ref[1], Y - ref[2]); // web-ifc è Y-up: riportiamo a Z-up (X, -Z, Y)
      }
      for (let j = 0; j < ix.length; j++) I.push(ix[j] + base);
    }
    const r = {pos: new Float64Array(P), idx: new Uint32Array(I), bolt: m.bolts.has(eid)};
    m.cache.set(eid, r);
    return r;
  }

  /** Espande un elemento negli elementi con geometria (assiemi -> pezzi) */
  function leaves(m, eid, out) {
    const k = m.kids.get(eid);
    if (k && k.length) k.forEach(c => leaves(m, c, out)); else out.add(eid);
    return out;
  }

  function volCentroid(mesh) {
    const p = mesh.pos, ix = mesh.idx; let V = 0, cx = 0, cy = 0, cz = 0;
    for (let j = 0; j < ix.length; j += 3) {
      const a = ix[j] * 3, b = ix[j + 1] * 3, c = ix[j + 2] * 3;
      const ax = p[a], ay = p[a + 1], az = p[a + 2], bx = p[b], by = p[b + 1], bz = p[b + 2], qx = p[c], qy = p[c + 1], qz = p[c + 2];
      const v = (ax * (by * qz - bz * qy) - ay * (bx * qz - bz * qx) + az * (bx * qy - by * qx)) / 6;
      V += v; cx += v * (ax + bx + qx) / 4; cy += v * (ay + by + qy) / 4; cz += v * (az + bz + qz) / 4;
    }
    if (Math.abs(V) < 1e-12) { // superficie aperta: media dei vertici
      let n = p.length / 3; cx = cy = cz = 0; for (let i = 0; i < p.length; i += 3) { cx += p[i]; cy += p[i + 1]; cz += p[i + 2]; }
      return {V: 0, c: [cx / n, cy / n, cz / n]};
    }
    return {V: Math.abs(V), c: [cx / V, cy / V, cz / V]};
  }
  function bboxOf(meshes) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    meshes.forEach(m => { const p = m.pos; for (let i = 0; i < p.length; i += 3) for (let d = 0; d < 3; d++) { const v = p[i + d]; if (v < mn[d]) mn[d] = v; if (v > mx[d]) mx[d] = v; } });
    return {mn, mx};
  }

  // ------------------------------------------------------------------ vettori
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

  // ------------------------------------------------------------------ spigoli significativi
  function featureEdges(mesh, angleDeg) {
    const p = mesh.pos, ix = mesh.idx, key = new Map(), weld = new Int32Array(p.length / 3);
    for (let i = 0; i < p.length / 3; i++) {
      const k = Math.round(p[i * 3] * 2e3) + ',' + Math.round(p[i * 3 + 1] * 2e3) + ',' + Math.round(p[i * 3 + 2] * 2e3);
      let w = key.get(k); if (w === undefined) { w = i; key.set(k, i); } weld[i] = w;
    }
    const edges = new Map(), cosT = Math.cos(angleDeg * Math.PI / 180);
    const nrm = [];
    for (let t = 0; t < ix.length; t += 3) {
      const a = weld[ix[t]], b = weld[ix[t + 1]], c = weld[ix[t + 2]];
      if (a === b || b === c || a === c) { nrm.push(null); continue; }
      const A = [p[a * 3], p[a * 3 + 1], p[a * 3 + 2]], B = [p[b * 3], p[b * 3 + 1], p[b * 3 + 2]], C = [p[c * 3], p[c * 3 + 1], p[c * 3 + 2]];
      const n = norm(cross([B[0] - A[0], B[1] - A[1], B[2] - A[2]], [C[0] - A[0], C[1] - A[1], C[2] - A[2]])); nrm.push(n);
      for (const [u, v] of [[a, b], [b, c], [c, a]]) { const k = u < v ? u * 4194304 + v : v * 4194304 + u; const e = edges.get(k); if (e) e.push(n); else edges.set(k, [n]); }
    }
    const out = [];
    edges.forEach((ns, k) => {
      const u = Math.floor(k / 4194304), v = k % 4194304;
      let keep = ns.length !== 2; if (!keep) keep = dot(ns[0], ns[1]) < cosT;
      if (keep) out.push([p[u * 3], p[u * 3 + 1], p[u * 3 + 2], p[v * 3], p[v * 3 + 1], p[v * 3 + 2]]);
    });
    return out;
  }

  // ------------------------------------------------------------------ proiezione con linee nascoste
  /** view: {f: direzione di vista, up}; restituisce segmenti visibili in (u,v) metri */
  function hiddenLine(meshes, edgeSets, view, res) {
    const f = norm(view.f), r = norm(cross(f, view.up)), up = cross(r, f);
    // centro dei pezzi: le proiezioni lavorano su coordinate piccole (precisione anche con origini UTM)
    let n0 = 0; const c0 = [0, 0, 0]; meshes.forEach(m => { for (let i = 0; i < m.pos.length; i += 3) { c0[0] += m.pos[i]; c0[1] += m.pos[i + 1]; c0[2] += m.pos[i + 2]; n0++; } });
    if (n0) { c0[0] /= n0; c0[1] /= n0; c0[2] /= n0; }
    const P0 = [c0[0] * r[0] + c0[1] * r[1] + c0[2] * r[2], c0[0] * up[0] + c0[1] * up[1] + c0[2] * up[2], c0[0] * f[0] + c0[1] * f[1] + c0[2] * f[2]];
    const prjL = (x, y, z) => { x -= c0[0]; y -= c0[1]; z -= c0[2]; return [x * r[0] + y * r[1] + z * r[2], x * up[0] + y * up[1] + z * up[2], x * f[0] + y * f[1] + z * f[2]]; };
    const prj = (x, y, z) => { const q = prjL(x, y, z); return [q[0] + P0[0], q[1] + P0[1], q[2] + P0[2]]; };
    // estensione
    let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
    const PP = meshes.map(m => { const q = new Float64Array(m.pos.length); for (let i = 0; i < m.pos.length; i += 3) { const s = prjL(m.pos[i], m.pos[i + 1], m.pos[i + 2]); q[i] = s[0]; q[i + 1] = s[1]; q[i + 2] = s[2]; if (s[0] < umin) umin = s[0]; if (s[0] > umax) umax = s[0]; if (s[1] < vmin) vmin = s[1]; if (s[1] > vmax) vmax = s[1]; } return q; });
    const span = Math.max(umax - umin, vmax - vmin, 1e-6), px = span / res;
    const W = Math.max(2, Math.ceil((umax - umin) / px) + 3), H = Math.max(2, Math.ceil((vmax - vmin) / px) + 3);
    const zb = new Float64Array(W * H).fill(Infinity);
    const gx = u => (u - umin) / px + 1, gy = v => (v - vmin) / px + 1;
    meshes.forEach((m, mi) => {
      const q = PP[mi], ix = m.idx;
      for (let t = 0; t < ix.length; t += 3) {
        const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
        const x0 = gx(q[a]), y0 = gy(q[a + 1]), z0 = q[a + 2], x1 = gx(q[b]), y1 = gy(q[b + 1]), z1 = q[b + 2], x2 = gx(q[c]), y2 = gy(q[c + 1]), z2 = q[c + 2];
        const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0); if (Math.abs(area) < 1e-9) continue;
        const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
        const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
        for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
          const w0 = ((x1 - x) * (y2 - y) - (x2 - x) * (y1 - y)) / area, w1 = ((x2 - x) * (y0 - y) - (x0 - x) * (y2 - y)) / area, w2 = 1 - w0 - w1;
          if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
          const z = w0 * z0 + w1 * z1 + w2 * z2, k = y * W + x; if (z < zb[k]) zb[k] = z;
        }
      }
    });
    const depthAt = (x, y) => { // minimo nell'intorno 3x3: tollera i bordi dei triangoli
      let z = Infinity; const xi = Math.round(x), yi = Math.round(y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = xi + dx, Y = yi + dy; if (X >= 0 && Y >= 0 && X < W && Y < H) { const v = zb[Y * W + X]; if (v < z) z = v; } }
      return z;
    };
    const eps = px * 2.5, segs = [];
    edgeSets.forEach(es => es.forEach(e => {
      const A = prjL(e[0], e[1], e[2]), B = prjL(e[3], e[4], e[5]);
      const L = Math.hypot(B[0] - A[0], B[1] - A[1]) / px; const n = Math.max(2, Math.ceil(L * 1.5));
      let start = -1;
      for (let i = 0; i <= n; i++) {
        const t = i / n, u = A[0] + (B[0] - A[0]) * t, v = A[1] + (B[1] - A[1]) * t, d = A[2] + (B[2] - A[2]) * t;
        const vis = d <= depthAt(gx(u), gy(v)) + eps;
        if (vis && start < 0) start = t;
        if ((!vis || i === n) && start >= 0) { const t1 = vis ? t : (i - 1) / n; if (t1 > start) segs.push([A[0] + (B[0] - A[0]) * start, A[1] + (B[1] - A[1]) * start, A[0] + (B[0] - A[0]) * t1, A[1] + (B[1] - A[1]) * t1]); start = -1; }
      }
    }));
    const out = mergeSegs(segs, px * 0.3).map(q => [q[0] + P0[0], q[1] + P0[1], q[2] + P0[0], q[3] + P0[1]]);
    return {segs: out, umin: umin + P0[0], umax: umax + P0[0], vmin: vmin + P0[1], vmax: vmax + P0[1], prj};
  }
  function mergeSegs(segs, tol) { // elimina i doppioni di segmenti coincidenti
    const seen = new Set(), out = [];
    for (const s of segs) { const k = [s[0], s[1], s[2], s[3]].map(v => Math.round(v / tol)).join(','), k2 = [s[2], s[3], s[0], s[1]].map(v => Math.round(v / tol)).join(','); if (seen.has(k) || seen.has(k2)) continue; seen.add(k); out.push(s); }
    return out;
  }

  // ------------------------------------------------------------------ tavola
  const SCALES = [1, 2, 5, 10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 500, 750, 1000, 1500, 2000, 2500, 5000];
  const nf = (v, d) => v.toLocaleString('it-IT', {minimumFractionDigits: d, maximumFractionDigits: d});

  /**
   * d = {meshes:[{pos,idx,bolt}] (coord. viewer, metri, relative a ref), ref:[x,y,z], cog:[x,y,z] assoluto,
   *      origin:{x,y,z}, rot (gradi), name, weight, boltWeight, nPieces, marks:[...], group, project, model, drawBolts}
   */
  function buildSheet(d) {
    const rot = (d.rot || 0) * Math.PI / 180, cr = Math.cos(rot), sr = Math.sin(rot);
    const o = [d.origin.x - d.ref[0], d.origin.y - d.ref[1], d.origin.z - d.ref[2]];
    const toL = (x, y, z) => { const dx = x - o[0], dy = y - o[1]; return [dx * cr + dy * sr, -dx * sr + dy * cr, z - o[2]]; };
    const draw = d.meshes.filter(m => d.drawBolts || !m.bolt);
    const local = draw.map(m => { const q = new Float64Array(m.pos.length); for (let i = 0; i < q.length; i += 3) { const s = toL(m.pos[i], m.pos[i + 1], m.pos[i + 2]); q[i] = s[0]; q[i + 1] = s[1]; q[i + 2] = s[2]; } return {pos: q, idx: m.idx}; });
    const edges = local.map(m => featureEdges(m, 25));
    const cogL = toL(d.cog[0] - d.ref[0], d.cog[1] - d.ref[1], d.cog[2] - d.ref[2]);
    const VIEWS = {
      front: {f: [0, 1, 0], up: [0, 0, 1], title: 'PROSPETTO', ax: ['X', 'Z']},
      plan: {f: [0, 0, -1], up: [0, 1, 0], title: 'PIANTA', ax: ['X', 'Y']},
      side: {f: [1, 0, 0], up: [0, 0, 1], title: 'SEZIONE (vista dall\'inizio dell\'asse X)', ax: ['Y', 'Z']},
      iso: {f: [1, 0.85, -0.75], up: [0, 0, 1], title: 'VISTA 3D (non in scala)'}
    };
    const res = 1400, H = {};
    for (const k in VIEWS) H[k] = hiddenLine(local, edges, VIEWS[k], k === 'iso' ? 1600 : res);

    // riquadri (mm, origine in basso a sinistra del foglio A3 orizzontale 420x297)
    const R = {front: [12, 128, 246, 112], plan: [12, 50, 246, 76], side: [260, 128, 148, 112], iso: [260, 50, 148, 76]};
    // la pianta prende metà della colonna: ridistribuisco in base alle proporzioni reali
    const wd = H.front.umax - H.front.umin || 1, hFront = H.front.vmax - H.front.vmin || 1, hPlan = H.plan.vmax - H.plan.vmin || 1;
    const top = 287, bot = 50, colH = top - bot, ratio = hFront / (hFront + hPlan);
    const fh = Math.min(colH - 60, Math.max(60, colH * ratio)), ph = colH - fh;
    R.front = [12, top - fh, 246, fh]; R.plan = [12, bot, 246, ph];
    R.side = [262, top - 122, 146, 122]; R.iso = [262, bot, 146, colH - 122];
    const need = k => { const h = H[k], r = R[k]; return Math.max((h.umax - h.umin) / (r[2] - 34), (h.vmax - h.vmin) / (r[3] - 26)) * 1000; };
    const needMax = Math.max(need('front'), need('plan'), need('side'));
    const S = SCALES.find(s => s >= needMax) || Math.ceil(needMax);
    const P = []; // primitive
    const L = (a, b, layer, w) => P.push({t: 'line', a, b, layer: layer || 'CONTORNI', w: w || 0.25});
    const T = (p, txt, size, layer, align) => P.push({t: 'text', p, txt: String(txt), s: size || 2.5, layer: layer || 'TESTI', align: align || 'left'});
    const C = (c, r, layer) => P.push({t: 'circle', c, r, layer: layer || 'BARICENTRO'});
    const SEC = (c, r, a0, a1, layer) => P.push({t: 'sector', c, r, a0, a1, layer: layer || 'BARICENTRO'});
    const rect = (x, y, w, h, layer, wt) => { L([x, y], [x + w, y], layer, wt); L([x + w, y], [x + w, y + h], layer, wt); L([x + w, y + h], [x, y + h], layer, wt); L([x, y + h], [x, y], layer, wt); };
    const cogSym = (c, r) => { C(c, r); SEC(c, r, 0, 90); SEC(c, r, 180, 270); L([c[0] - r * 1.6, c[1]], [c[0] + r * 1.6, c[1]], 'BARICENTRO', 0.18); L([c[0], c[1] - r * 1.6], [c[0], c[1] + r * 1.6], 'BARICENTRO', 0.18); };

    // cornice
    rect(5, 5, 410, 287, 'CORNICE', 0.5);

    function placeView(k, scaleDen) {
      const h = H[k], r = R[k];
      const k2 = scaleDen ? 1000 / scaleDen : Math.min((r[2] - 16) / (h.umax - h.umin || 1), (r[3] - 16) / (h.vmax - h.vmin || 1));
      const cu = (h.umin + h.umax) / 2, cv = (h.vmin + h.vmax) / 2;
      const ox = r[0] + r[2] / 2 + (scaleDen ? -6 : 0), oy = r[1] + r[3] / 2 + (scaleDen ? 6 : -2);
      const map = (u, v) => [ox + (u - cu) * k2, oy + (v - cv) * k2];
      h.segs.forEach(s => L(map(s[0], s[1]), map(s[2], s[3]), k === 'iso' ? 'VISTA_3D' : 'CONTORNI', 0.3));
      T([r[0] + 2, r[1] + r[3] - 4], VIEWS[k].title + (scaleDen ? '   1:' + S : ''), 2.8, 'TESTI');
      const c3 = h.prj(cogL[0], cogL[1], cogL[2]), cp = map(c3[0], c3[1]);
      cogSym(cp, 2.2);
      if (!scaleDen) { T([cp[0] + 3.5, cp[1] + 2.5], 'COG', 2.5, 'BARICENTRO'); return; }
      // quote: orizzontale sotto, verticale a destra
      const p0 = map(h.umin, h.vmin), p1 = map(h.umax, h.vmax);
      const yq = p0[1] - 7, xq = p1[0] + 7;
      const hdim = (xa, xb, y, txt) => { L([xa, y], [xb, y], 'QUOTE', 0.18); L([xa, y - 1.5], [xa, y + 1.5], 'QUOTE', 0.18); L([xb, y - 1.5], [xb, y + 1.5], 'QUOTE', 0.18); T([(xa + xb) / 2, y + 1], txt, 2.2, 'QUOTE', 'center'); };
      const vdim = (ya, yb, x, txt) => { L([x, ya], [x, yb], 'QUOTE', 0.18); L([x - 1.5, ya], [x + 1.5, ya], 'QUOTE', 0.18); L([x - 1.5, yb], [x + 1.5, yb], 'QUOTE', 0.18); T([x + 1.5, (ya + yb) / 2], txt, 2.2, 'QUOTE', 'left'); };
      const mm = v => nf(v * 1000, 0);
      // richiami
      L([p0[0], p0[1] - 1], [p0[0], yq - 2], 'QUOTE', 0.13); L([p1[0], p0[1] - 1], [p1[0], yq - 2], 'QUOTE', 0.13); L([cp[0], cp[1] - 2.5], [cp[0], yq - 2], 'QUOTE', 0.13);
      L([p1[0] + 1, p0[1]], [xq + 2, p0[1]], 'QUOTE', 0.13); L([p1[0] + 1, p1[1]], [xq + 2, p1[1]], 'QUOTE', 0.13); L([cp[0] + 2.5, cp[1]], [xq + 2, cp[1]], 'QUOTE', 0.13);
      hdim(p0[0], cp[0], yq, mm(c3[0] - h.umin)); hdim(cp[0], p1[0], yq, mm(h.umax - c3[0])); hdim(p0[0], p1[0], yq - 6, mm(h.umax - h.umin));
      vdim(p0[1], cp[1], xq, mm(c3[1] - h.vmin)); vdim(cp[1], p1[1], xq, mm(h.vmax - c3[1])); vdim(p0[1], p1[1], xq + 12, mm(h.vmax - h.vmin));
      const ax = VIEWS[k].ax, cl = {X: cogL[0], Y: cogL[1], Z: cogL[2]};
      T([cp[0] - 3, cp[1] + 4], `COG  ${ax[0]} ${nf(cl[ax[0]], 3)}  ${ax[1]} ${nf(cl[ax[1]], 3)}`, 2.4, 'BARICENTRO', 'right');
      // origine del gruppo, se cade nel riquadro
      const o3 = h.prj(0, 0, 0), op = map(o3[0], o3[1]);
      if (op[0] > r[0] + 2 && op[0] < r[0] + r[2] - 2 && op[1] > r[1] + 2 && op[1] < r[1] + r[3] - 6) {
        L([op[0] - 3, op[1] - 3], [op[0] + 3, op[1] + 3], 'ORIGINE', 0.25); L([op[0] - 3, op[1] + 3], [op[0] + 3, op[1] - 3], 'ORIGINE', 0.25); T([op[0] + 3, op[1] - 4], '0,0,0', 2.2, 'ORIGINE');
      }
      // freccia degli assi
      const ax0 = [r[0] + 6, r[1] + 6]; L(ax0, [ax0[0] + 8, ax0[1]], 'TESTI', 0.18); L(ax0, [ax0[0], ax0[1] + 8], 'TESTI', 0.18);
      const sgn = (k === 'side') ? '-' : ''; T([ax0[0] + 9, ax0[1] - 1], sgn + ax[0], 2.2); T([ax0[0] - 1, ax0[1] + 9.5], ax[1], 2.2);
    }
    placeView('front', S); placeView('plan', S); placeView('side', S); placeView('iso', 0);
    for (const k of ['front', 'plan', 'side', 'iso']) rect(...R[k], 'CORNICE', 0.18);

    // tabella e cartiglio
    const ty = 8, th = 38;
    rect(12, ty, 396, th, 'CORNICE', 0.35); L([212, ty], [212, ty + th], 'CORNICE', 0.25); L([322, ty], [322, ty + th], 'CORNICE', 0.25);
    const cg = cogL, ca = d.cog;
    const lines = [
      ['Baricentro', d.name], ['Peso totale', `${nf(d.weight, 1)} kg  (${nf(d.weight / 1000, 3)} t)`],
      ['di cui bulloneria', d.boltWeight > 0 ? `${nf(d.boltWeight, 1)} kg (da volume)` : 'non conteggiata'], ['Pezzi', String(d.nPieces)],
      ['COG nel gruppo', `X ${nf(cg[0], 3)}   Y ${nf(cg[1], 3)}   Z ${nf(cg[2], 3)} m`],
      ['COG nel modello', `X ${nf(ca[0], 3)}   Y ${nf(ca[1], 3)}   Z ${nf(ca[2], 3)} m`],
      ['Origine gruppo', `X ${nf(d.origin.x, 3)}  Y ${nf(d.origin.y, 3)}  Z ${nf(d.origin.z, 3)}  rot. ${nf(d.rot || 0, 2)}°`]];
    lines.forEach((l, i) => { T([14, ty + th - 4 - i * 4.5], l[0], 2.3, 'TESTI'); T([46, ty + th - 4 - i * 4.5], l[1], 2.5, 'TESTI'); });
    T([214, ty + th - 5], 'ELEMENTI', 2.2, 'TESTI');
    const marks = (d.marks || []).join(', '); const mlines = wrap(marks, 58).slice(0, 6);
    mlines.forEach((l, i) => T([214, ty + th - 10 - i * 4.2], l, 2.2, 'TESTI'));
    T([324, ty + th - 5], d.project || '', 2.6, 'TESTI'); T([324, ty + th - 10], d.model || '', 2.2, 'TESTI');
    T([324, ty + th - 16], `Gruppo: ${d.group || ''}`, 2.4, 'TESTI');
    T([324, ty + th - 22], `Viste 2D in scala 1:${S} su A3`, 2.4, 'TESTI'); T([324, ty + th - 27], `Data ${new Date().toLocaleDateString('it-IT')}`, 2.2, 'TESTI');
    T([324, ty + 3], 'Peso e baricentro · Trimble Connect', 2.0, 'TESTI');
    T([214, ty + 2], 'Quote in mm. COG sui volumi reali dei pezzi, pesati col peso del modello.', 1.8, 'TESTI');
    return {prims: P, scale: S, cogLocal: cogL};
  }
  function wrap(s, n) { const out = []; let cur = ''; s.split(', ').forEach(w => { if ((cur + ', ' + w).length > n && cur) { out.push(cur + ','); cur = w; } else cur = cur ? cur + ', ' + w : w; }); if (cur) out.push(cur); return out; }

  // ------------------------------------------------------------------ PDF
  const LW = {FUNI: [31, 95, 191], GOLFARI: [180, 120, 0], ASSI: [120, 120, 120], CONTORNI: [0, 0, 0], VISTA_3D: [40, 40, 40], QUOTE: [0, 90, 160], BARICENTRO: [200, 30, 30], ORIGINE: [0, 130, 60], TESTI: [20, 20, 20], CORNICE: [0, 0, 0]};
  function toPdf(doc, prims, addPage) {
    if (addPage) doc.addPage('a3', 'landscape');
    const Hh = 297, Y = y => Hh - y;
    for (const p of prims) {
      const c = LW[p.layer] || [0, 0, 0];
      if (p.t === 'line') { doc.setDrawColor(...c); doc.setLineWidth(p.w); doc.line(p.a[0], Y(p.a[1]), p.b[0], Y(p.b[1])); }
      else if (p.t === 'circle') { doc.setDrawColor(...c); doc.setLineWidth(0.25); doc.circle(p.c[0], Y(p.c[1]), p.r, 'S'); }
      else if (p.t === 'sector') {
        doc.setFillColor(...c); const pts = [[p.c[0], Y(p.c[1])]];
        for (let a = p.a0; a <= p.a1 + 0.01; a += 10) pts.push([p.c[0] + p.r * Math.cos(a * Math.PI / 180), Y(p.c[1] + p.r * Math.sin(a * Math.PI / 180))]);
        const lines = []; for (let i = 1; i < pts.length; i++) lines.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]);
        doc.lines(lines, pts[0][0], pts[0][1], [1, 1], 'F', true);
      } else if (p.t === 'text') { doc.setTextColor(...c); doc.setFontSize(p.s / 0.3528); doc.text(p.txt, p.a ? p.a[0] : p.p[0], Y(p.p[1]), {align: p.align, baseline: 'middle'}); }
    }
  }

  // ------------------------------------------------------------------ DXF (R12, unità = mm reali per le viste in scala)
  const DXFCOL = {FUNI: 5, GOLFARI: 2, ASSI: 8, CONTORNI: 7, VISTA_3D: 8, QUOTE: 4, BARICENTRO: 1, ORIGINE: 3, TESTI: 7, CORNICE: 7};
  function toDxf(prims, S) { return toDxfMulti([{prims, S}]); }
  function toDxfMulti(sheets) {
    const o = [];
    const g = (c, v) => o.push(String(c), String(v));
    g(0, 'SECTION'); g(2, 'HEADER'); g(9, '$ACADVER'); g(1, 'AC1009'); g(9, '$INSUNITS'); g(70, 4); g(0, 'ENDSEC');
    g(0, 'SECTION'); g(2, 'TABLES'); g(0, 'TABLE'); g(2, 'LAYER'); g(70, Object.keys(DXFCOL).length);
    for (const [n, c] of Object.entries(DXFCOL)) { g(0, 'LAYER'); g(2, n); g(70, 0); g(62, c); g(6, 'CONTINUOUS'); }
    g(0, 'ENDTAB'); g(0, 'ENDSEC'); g(0, 'SECTION'); g(2, 'ENTITIES');
    let ox = 0;
    for (const sh of sheets) {
    const k = sh.S, prims = sh.prims;
    const fx = v => (v * k + ox).toFixed(3), f = v => (v * k).toFixed(3);
    for (const p of prims) {
      if (p.t === 'line') { g(0, 'LINE'); g(8, p.layer); g(10, fx(p.a[0])); g(20, f(p.a[1])); g(30, 0); g(11, fx(p.b[0])); g(21, f(p.b[1])); g(31, 0); }
      else if (p.t === 'circle') { g(0, 'CIRCLE'); g(8, p.layer); g(10, fx(p.c[0])); g(20, f(p.c[1])); g(30, 0); g(40, f(p.r)); }
      else if (p.t === 'sector') {
        for (let a = p.a0; a < p.a1; a += 15) { const b = Math.min(a + 15, p.a1), q = [p.c, [p.c[0] + p.r * Math.cos(a * Math.PI / 180), p.c[1] + p.r * Math.sin(a * Math.PI / 180)], [p.c[0] + p.r * Math.cos(b * Math.PI / 180), p.c[1] + p.r * Math.sin(b * Math.PI / 180)]];
          g(0, 'SOLID'); g(8, p.layer); g(10, fx(q[0][0])); g(20, f(q[0][1])); g(30, 0); g(11, fx(q[1][0])); g(21, f(q[1][1])); g(31, 0); g(12, fx(q[2][0])); g(22, f(q[2][1])); g(32, 0); g(13, fx(q[2][0])); g(23, f(q[2][1])); g(33, 0); }
      } else if (p.t === 'text') {
        const al = p.align === 'center' ? 1 : p.align === 'right' ? 2 : 0;
        g(0, 'TEXT'); g(8, p.layer); g(10, fx(p.p[0])); g(20, f(p.p[1] - p.s * 0.35)); g(30, 0); g(40, f(p.s * 0.75)); g(1, ascii(p.txt));
        if (al) { g(72, al); g(11, fx(p.p[0])); g(21, f(p.p[1] - p.s * 0.35)); g(31, 0); }
      }
    }
    ox += (420 + 30) * k;
    }
    g(0, 'ENDSEC'); g(0, 'EOF');
    return o.join('\r\n') + '\r\n';
  }
  function ascii(s) { return s.replace(/°/g, '%%d').replace(/[^\x20-\x7e%]/g, ch => ({'à': 'a', 'è': 'e', 'é': 'e', 'ì': 'i', 'ò': 'o', 'ù': 'u', '·': '-', '×': 'x', '₀': '0'}[ch] || '?')); }


  // ------------------------------------------------------------------ GOLFARI
  /**
   * Analizza un macroconcio per il posizionamento dei golfari.
   * meshes: [{pos (relative a ref), idx, bolt}], cogR: baricentro relativo a ref.
   * Restituisce un oggetto con travi rilevate, assi trasversali (diaframmi/irrigidimenti) e funzioni di calcolo.
   */
  function liftModel(meshes, cogR, opt = {}) {
    const cell = opt.cell || 0.05;
    // asse longitudinale (PCA in pianta)
    let sxx = 0, syy = 0, sxy = 0, n = 0;
    meshes.forEach(m => { const p = m.pos; for (let i = 0; i < p.length; i += 9) { const x = p[i] - cogR[0], y = p[i + 1] - cogR[1]; sxx += x * x; syy += y * y; sxy += x * y; n++; } });
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy), ax = [Math.cos(ang), Math.sin(ang)], pv = [-ax[1], ax[0]];
    const toUV = (x, y) => { const dx = x - cogR[0], dy = y - cogR[1]; return [dx * ax[0] + dy * ax[1], dx * pv[0] + dy * pv[1]]; };
    const fromUV = (u, v) => [cogR[0] + u * ax[0] + v * pv[0], cogR[1] + u * ax[1] + v * pv[1]];
    // elementi: ingombro locale e classe
    const els = meshes.map((m, i) => {
      const p = m.pos; let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let k = 0; k < p.length; k += 3) { const [u, v] = toUV(p[k], p[k + 1]); if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v; if (p[k + 2] < z0) z0 = p[k + 2]; if (p[k + 2] > z1) z1 = p[k + 2]; }
      const small = m.bolt || (u1 - u0 < 0.25 && v1 - v0 < 0.25);
      return {i, m, u0, u1, v0, v1, z0, z1, small, label: m.label || ''};
    });
    let U0 = Infinity, U1 = -Infinity, V0 = Infinity, V1 = -Infinity;
    els.forEach(e => { if (e.small) return; U0 = Math.min(U0, e.u0); U1 = Math.max(U1, e.u1); V0 = Math.min(V0, e.v0); V1 = Math.max(V1, e.v1); });
    const NU = Math.ceil((U1 - U0) / cell) + 2, NV = Math.ceil((V1 - V0) / cell) + 2;
    const zt = new Float32Array(NU * NV).fill(-Infinity), owner = new Int32Array(NU * NV).fill(-1);
    const gu = u => (u - U0) / cell, gv = v => (v - V0) / cell;
    // mappa delle superfici superiori (facce rivolte verso l'alto), esclusi pioli e bulloni
    els.forEach(e => {
      if (e.small) return; const p = e.m.pos, ix = e.m.idx;
      for (let t = 0; t < ix.length; t += 3) {
        const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
        const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]], e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
        const nz = e1[0] * e2[1] - e1[1] * e2[0], nl = Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], nz);
        if (!nl || Math.abs(nz) / nl < 0.7) continue;
        const A = toUV(p[a], p[a + 1]), B = toUV(p[b], p[b + 1]), C = toUV(p[c], p[c + 1]);
        const x0 = gu(A[0]), y0 = gv(A[1]), x1 = gu(B[0]), y1 = gv(B[1]), x2 = gu(C[0]), y2 = gv(C[1]);
        const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0); if (Math.abs(area) < 1e-9) continue;
        const za = p[a + 2], zb = p[b + 2], zc = p[c + 2];
        for (let y = Math.max(0, Math.floor(Math.min(y0, y1, y2))); y <= Math.min(NV - 1, Math.ceil(Math.max(y0, y1, y2))); y++)
          for (let x = Math.max(0, Math.floor(Math.min(x0, x1, x2))); x <= Math.min(NU - 1, Math.ceil(Math.max(x0, x1, x2))); x++) {
            const w0 = ((x1 - x) * (y2 - y) - (x2 - x) * (y1 - y)) / area, w1 = ((x2 - x) * (y0 - y) - (x0 - x) * (y2 - y)) / area, w2 = 1 - w0 - w1;
            if (w0 < -0.02 || w1 < -0.02 || w2 < -0.02) continue;
            const z = w0 * za + w1 * zb + w2 * zc, k = x * NV + y; if (z > zt[k]) { zt[k] = z; owner[k] = e.i; }
          }
      }
    });
    // profilo trasversale a una progressiva u: tratti di piattabanda (superficie al livello superiore)
    function strips(u) {
      const xc = Math.round(gu(u)); if (xc < 0 || xc >= NU) return [];
      // mediana su 5 colonne: elimina oggetti isolati (golfari esistenti, pioli)
      const zrow = new Float32Array(NV), col = [];
      for (let y = 0; y < NV; y++) { col.length = 0; for (let x = Math.max(0, xc - 2); x <= Math.min(NU - 1, xc + 2); x++) col.push(zt[x * NV + y]); col.sort((a, b) => a - b); zrow[y] = col[Math.floor(col.length / 2)]; }
      // tratti piani (quota quasi costante)
      const runs = []; let s = 0;
      for (let y = 1; y <= NV; y++) {
        const brk = y === NV || !isFinite(zrow[y]) !== !isFinite(zrow[s]) || (isFinite(zrow[y]) && Math.abs(zrow[y] - zrow[y - 1]) > 0.02);
        if (brk) { const e = y - 1; let zm = -Infinity; for (let k = s; k <= e; k++) zm = Math.max(zm, zrow[k]); runs.push({s, e, z: zm}); s = y; }
      }
      // unisce tratti alla stessa quota separati da piccole interruzioni (piatti verticali sottili)
      const fin = runs.filter(r => isFinite(r.z));
      const merged = [];
      fin.forEach(r => { const l = merged[merged.length - 1]; if (l && r.s - l.e <= 3 && Math.abs(r.z - l.z) < 0.03) { l.e = r.e; l.z = Math.max(l.z, r.z); } else merged.push({...r}); });
      // piattabanda: tratto piano più alto di quanto c'è ai lati, largo 0.15-1.6 m
      const out = [];
      merged.forEach((r, i) => {
        const w = (r.e - r.s + 1) * cell; if (w < 0.15 || w > 1.6) return;
        let left = -Infinity, right = -Infinity;
        for (let k = Math.max(0, r.s - 6); k < r.s; k++) if (isFinite(zrow[k])) left = Math.max(left, zrow[k]);
        for (let k = r.e + 1; k <= Math.min(NV - 1, r.e + 6); k++) if (isFinite(zrow[k])) right = Math.max(right, zrow[k]);
        if (left > r.z - 0.08 || right > r.z - 0.08) return;
        out.push({v: V0 + ((r.s + r.e) / 2) * cell, w, z: r.z});
      });
      return out;
    }
    const g0 = strips(0);
    // traccia la linea di ogni trave lungo u (travi curve: si segue la piattabanda passo passo)
    const track = g0.map(st => { const m = new Map(); m.set(0, st); return m; });
    function girderAt(gi, u) {
      const step = 0.5, key = Math.round(u / step); const m = track[gi];
      if (m.has(key)) return m.get(key);
      const dir = key > 0 ? 1 : -1; let k = 0, prev = m.get(0);
      while (k !== key) { k += dir; if (m.has(k)) { prev = m.get(k); continue; }
        const ss = strips(k * step); let best = null; ss.forEach(s => { if (!best || Math.abs(s.v - prev.v) < Math.abs(best.v - prev.v)) best = s; });
        const cur = best && Math.abs(best.v - prev.v) < 0.6 ? best : {v: prev.v, w: prev.w, z: prev.z, missing: true};
        m.set(k, cur); prev = cur; }
      return m.get(key);
    }
    // assi trasversali: elementi sottili in senso longitudinale e alti (diaframmi, irrigidimenti, fazzoletti dei traversi)
    const stations = g0.map(() => []);
    els.forEach(e => {
      if (e.small || e.u1 - e.u0 > 0.15 || e.z1 - e.z0 < 0.3) return;
      const uc = (e.u0 + e.u1) / 2;
      g0.forEach((_, gi) => { const g = girderAt(gi, uc); if (e.v1 > g.v - g.w / 2 - 0.3 && e.v0 < g.v + g.w / 2 + 0.3) stations[gi].push({u: uc, el: e.i}); });
    });
    stations.forEach((arr, gi) => { arr.sort((a, b) => a.u - b.u); const merged = [];
      arr.forEach(s => { const l = merged[merged.length - 1]; if (l && s.u - l.u < 0.08) { l.u = (l.u * l.n + s.u) / (l.n + 1); l.n++; } else merged.push({u: s.u, n: 1, el: s.el}); });
      stations[gi] = merged; });
    // punto sulla piattabanda della trave gi alla progressiva u, con verifica dell'appoggio
    function pointAt(gi, u, lugL = 0.55, lugW = 0.15) {
      const g = girderAt(gi, u); const v = g.v;
      let tot = 0, ok = 0, zsum = 0, own = new Map();
      for (let du = -lugL / 2; du <= lugL / 2 + 1e-9; du += cell) for (let dv = -lugW / 2; dv <= lugW / 2 + 1e-9; dv += cell) {
        const x = Math.round(gu(u + du)), y = Math.round(gv(v + dv)); tot++;
        if (x < 0 || y < 0 || x >= NU || y >= NV) continue; const z = zt[x * NV + y];
        if (z > g.z - 0.06) { ok++; zsum += z; const o = owner[x * NV + y]; own.set(o, (own.get(o) || 0) + 1); }
      }
      let main = -1, mc = 0; own.forEach((c, o) => { if (c > mc) { mc = c; main = o; } });
      const z = ok ? zsum / ok : g.z;
      // pioli/bulloni nell'impronta del golfare
      let studs = 0;
      els.forEach(e => { if (!e.small) return; const uc = (e.u0 + e.u1) / 2, vc = (e.v0 + e.v1) / 2;
        if (Math.abs(uc - u) < lugL / 2 + 0.03 && Math.abs(vc - v) < lugW / 2 + 0.06 && e.z1 > z - 0.02 && e.z0 < z + 0.4) studs++; });
      const xy = fromUV(u, v);
      return {gi, u, v, x: xy[0], y: xy[1], z, d: Math.hypot(u, v), support: tot ? ok / tot : 0, el: main >= 0 ? els[main].m : null, studs, missing: !!g.missing};
    }
    const L = U1 - U0;
    return {ax, pv, girders: g0, stations, pointAt, girderAt, strips, length: L, umin: U0, umax: U1, cell, _dbg: {zt, NU, NV, U0, V0, els}};
  }

  /** propone i golfari: n = 2 o 4; girders = indici delle travi; R = distanza imposta (null = automatico sugli assi) */
  function placeLugs(lm, cfg) {
    const n = cfg.n, gs = cfg.girders, target = cfg.target || lm.length / 6, axial = cfg.metric !== 'radial';
    const metric = (u, v) => axial ? Math.abs(u) : Math.hypot(u, v);
    const sides = [-1, 1], slots = []; gs.forEach(g => sides.forEach(s => slots.push({g, s})));
    if (cfg.R) { // distanza imposta: si risolve la progressiva che dà quella distanza dal baricentro
      const pts = slots.map(({g, s}) => { if (axial) return lm.pointAt(g, s * cfg.R, cfg.lugL, cfg.lugW);
        let lo = 0, hi = s > 0 ? lm.umax : -lm.umin;
        for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2, p = lm.pointAt(g, s * mid); if (p.d < cfg.R) lo = mid; else hi = mid; }
        return lm.pointAt(g, s * (lo + hi) / 2, cfg.lugL, cfg.lugW); });
      return {mode: 'manuale', R: cfg.R, points: pts, alternatives: []};
    }
    // automatico: per ogni raggio candidato si sceglie l'asse più vicino per ogni trave e lato
    const cand = new Set(); const dists = slots.map(({g, s}) => lm.stations[g].filter(st => st.u * s > 0.5).map(st => ({u: st.u, d: metric(st.u, lm.girderAt(g, st.u).v)})));
    dists.forEach(arr => arr.forEach(x => cand.add(Math.round(x.d * 1000) / 1000)));
    const combos = [];
    cand.forEach(R => {
      if (dists.some(a => !a.length)) return;
      const pick = dists.map(a => a.reduce((b, x) => Math.abs(x.d - R) < Math.abs(b.d - R) ? x : b));
      const ds = pick.map(p => p.d), dev = Math.max(...ds) - Math.min(...ds), mean = ds.reduce((a, b) => a + b, 0) / ds.length;
      const key = pick.map(p => p.u.toFixed(2)).join('|'); if (combos.some(c => c.key === key)) return;
      combos.push({key, pick, dev, mean});
    });
    // costo: vicinanza alla distanza obiettivo, scarto fra i golfari oltre 5 cm, appoggio incompleto, pioli/bulloni nell'impronta
    combos.forEach(c => {
      const pts = c.pick.map((p, i) => lm.pointAt(slots[i].g, p.u, cfg.lugL, cfg.lugW));
      const bad = pts.some(p => p.support < 0.9), studs = pts.reduce((a, p) => a + p.studs, 0);
      c.cost = 2 * Math.abs(c.mean - target) / Math.max(target, 1) + 8 * Math.max(0, c.dev - 0.05) + (bad ? 5 : 0) + (studs ? 1 : 0);
    });
    combos.sort((a, b) => a.cost - b.cost);
    const top = combos.slice(0, 8).map(c => ({dev: c.dev, mean: c.mean, us: c.pick.map(p => p.u)}));
    const best = top[cfg.alt || 0];
    if (!best) return {mode: 'auto', points: [], alternatives: [], error: 'nessun asse di diaframma o irrigidimento trovato sui due lati del baricentro'};
    return {mode: 'auto', R: best.mean, dev: best.dev, points: slots.map((sl, i) => lm.pointAt(sl.g, best.us[i])), alternatives: top};
  }

  /** carichi e funi: P per golfare (ripartizione statica), lunghezza, angolo, tiro */
  function slingForces(points, W, hookZ) {
    const n = points.length; let P;
    if (n === 2) { const [a, b] = points; const da = Math.abs(a.u), db = Math.abs(b.u); P = [W * db / (da + db), W * da / (da + db)]; }
    else { // due travi x due lati: ripartizione bilineare (trasversale poi longitudinale)
      const byG = {}; points.forEach((p, i) => (byG[p.gi] ||= []).push(i)); const G = Object.keys(byG);
      const vA = Math.abs(points[byG[G[0]][0]].v), vB = Math.abs(points[byG[G[1]][0]].v);
      const WA = W * vB / (vA + vB), WB = W * vA / (vA + vB); P = new Array(n);
      [[G[0], WA], [G[1], WB]].forEach(([g, Wg]) => { const [i, j] = byG[g]; const di = Math.abs(points[i].u), dj = Math.abs(points[j].u); P[i] = Wg * dj / (di + dj); P[j] = Wg * di / (di + dj); });
    }
    return points.map((p, i) => { const h = hookZ - p.z, Ls = Math.hypot(p.d, h), alpha = Math.atan2(h, p.d) * 180 / Math.PI; return {P: P[i], Ls, alpha, T: P[i] / Math.sin(alpha * Math.PI / 180)}; });
  }

  // ------------------------------------------------------------------ TAVOLA DI SOLLEVAMENTO (golfari e funi)
  /**
   * d = {meshes (rel. ref), ref, cog (ass.), ax:[ax,ay], lugs:[{x,y,z,label,T,P,alpha,Ls,g,type,shackle}], hook:[x,y,z],
   *      name, weight, project, model, group, drawBolts, fd}
   */
  function buildLugSheet(d) {
    const ax = d.ax, pv = [-ax[1], ax[0]], c0 = d.cog;
    const toL = (x, y, z) => { const dx = x - c0[0], dy = y - c0[1]; return [dx * ax[0] + dy * ax[1], dx * pv[0] + dy * pv[1], z - c0[2]]; };
    const draw = d.meshes.filter(m => d.drawBolts || !m.bolt);
    const local = draw.map(m => { const q = new Float64Array(m.pos.length); for (let i = 0; i < q.length; i += 3) { const s = toL(m.pos[i] + d.ref[0], m.pos[i + 1] + d.ref[1], m.pos[i + 2] + d.ref[2]); q[i] = s[0]; q[i + 1] = s[1]; q[i + 2] = s[2]; } return {pos: q, idx: m.idx}; });
    const edges = local.map(m => featureEdges(m, 25));
    const lugs = d.lugs.map(l => ({...l, L: toL(l.x, l.y, l.z)})), hook = toL(d.hook[0], d.hook[1], d.hook[2]);
    const VIEWS = {front: {f: [0, 1, 0], up: [0, 0, 1], title: 'PROSPETTO'}, plan: {f: [0, 0, -1], up: [0, 1, 0], title: 'PIANTA'}, side: {f: [1, 0, 0], up: [0, 0, 1], title: 'SEZIONE TRASVERSALE'}};
    const H = {}; for (const k in VIEWS) H[k] = hiddenLine(local, edges, VIEWS[k], 1400);
    // ingombri comprensivi di funi e gancio
    const ext = k => { const h = H[k]; let u0 = h.umin, u1 = h.umax, v0 = h.vmin, v1 = h.vmax; [hook, ...lugs.map(l => l.L)].forEach(p => { const q = h.prj(p[0], p[1], p[2]); u0 = Math.min(u0, q[0]); u1 = Math.max(u1, q[0]); v0 = Math.min(v0, q[1]); v1 = Math.max(v1, q[1]); }); return {u0, u1, v0, v1}; };
    const E = {front: ext('front'), plan: ext('plan'), side: ext('side')};
    const top = 287, bot = 50;
    const R = {front: [12, top - 125, 270, 125], plan: [12, bot, 270, top - 125 - bot], side: [284, top - 125, 124, 125], tab: [284, bot, 124, top - 125 - bot]};
    const need = k => { const e = E[k], r = R[k]; return Math.max((e.u1 - e.u0) / (r[2] - 30), (e.v1 - e.v0) / (r[3] - 26)) * 1000; };
    const S = SCALES.find(s => s >= Math.max(need('front'), need('plan'), need('side'))) || 5000;
    const P = [];
    const Ln = (a, b, layer, w) => P.push({t: 'line', a, b, layer: layer || 'CONTORNI', w: w || 0.25});
    const T = (p, txt, size, layer, align) => P.push({t: 'text', p, txt: String(txt), s: size || 2.5, layer: layer || 'TESTI', align: align || 'left'});
    const C = (c, r, layer) => P.push({t: 'circle', c, r, layer: layer || 'BARICENTRO'});
    const SEC = (c, r, a0, a1, layer) => P.push({t: 'sector', c, r, a0, a1, layer: layer || 'BARICENTRO'});
    const rect = (x, y, w, h, layer, wt) => { Ln([x, y], [x + w, y], layer, wt); Ln([x + w, y], [x + w, y + h], layer, wt); Ln([x + w, y + h], [x, y + h], layer, wt); Ln([x, y + h], [x, y], layer, wt); };
    const cogSym = (c, r) => { C(c, r); SEC(c, r, 0, 90); SEC(c, r, 180, 270); };
    const dashed = (a, b, layer) => { const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.floor(L / 4)); for (let i = 0; i < n; i++) { const t0 = i / n, t1 = (i + 0.6) / n; Ln([a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0], [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1], layer || 'ASSI', 0.13); } };
    const mm = v => nf(Math.abs(v) * 1000, 0);
    // raggruppa valori vicini (golfari di due travi quasi alla stessa progressiva): una quota con i due valori
    const clusters = vals => { const sorted = [...vals].sort((a, b) => a - b), out = [];
      sorted.forEach(v => { const l = out[out.length - 1]; if (l && Math.abs(v - l.vals[l.vals.length - 1]) < 0.25) l.vals.push(v); else out.push({vals: [v]}); });
      return out.map(c => ({v: c.vals.reduce((a, b) => a + b, 0) / c.vals.length, txt: [...new Set(c.vals.map(x => mm(x)))].join(' / ')})); };
    rect(5, 5, 410, 287, 'CORNICE', 0.5);
    for (const k of ['front', 'plan', 'side', 'tab']) rect(...R[k], 'CORNICE', 0.18);
    function place(k) {
      const h = H[k], e = E[k], r = R[k], k2 = 1000 / S;
      const cu = (e.u0 + e.u1) / 2, cv = (e.v0 + e.v1) / 2, ox = r[0] + r[2] / 2 - 4, oy = r[1] + r[3] / 2 + 2;
      const map = (u, v) => [ox + (u - cu) * k2, oy + (v - cv) * k2];
      const pm = p => { const q = h.prj(p[0], p[1], p[2]); return map(q[0], q[1]); };
      h.segs.forEach(sg => Ln(map(sg[0], sg[1]), map(sg[2], sg[3]), 'CONTORNI', 0.25));
      T([r[0] + 2, r[1] + r[3] - 4], VIEWS[k].title + '   1:' + S, 2.8);
      const cp = pm([0, 0, 0]), hp = pm(hook);
      // asse baricentro
      if (k !== 'plan') dashed([cp[0], r[1] + 4], [cp[0], r[1] + r[3] - 8], 'ASSI'), T([cp[0] + 1, r[1] + 8], 'asse baricentro', 1.8, 'ASSI');
      else { dashed([r[0] + 4, cp[1]], [r[0] + r[2] - 4, cp[1]], 'ASSI'); dashed([cp[0], r[1] + 4], [cp[0], r[1] + r[3] - 8], 'ASSI'); }
      // funi
      const grp = new Map(); // golfari che in questa vista cadono nello stesso punto: etichetta unica
      lugs.forEach((l, i) => { const lp = pm([l.L[0], l.L[1], l.L[2] + 0.16]); Ln(lp, hp, 'FUNI', 0.45);
        const key = Math.round(lp[0] / 10) + ',' + Math.round(lp[1] / 10); if (!grp.has(key)) grp.set(key, {lp, ids: [], al: []}); grp.get(key).ids.push(i + 1); grp.get(key).al.push(l.alpha); });
      grp.forEach(gq => { const lp = gq.lp, mid = [(lp[0] + hp[0]) / 2, (lp[1] + hp[1]) / 2], left = lp[0] < hp[0] - 0.5;
        T([mid[0] + (left ? -2 : 2), mid[1] + 1.5], gq.ids.map(x => 'F' + x).join('/'), 2.4, 'FUNI', left ? 'right' : 'left');
        if (k === 'front') T([lp[0] + (left ? -2 : 2), lp[1] - 6], gq.al.map(a => nf(a, 1) + '°').join(' / '), 2.1, 'QUOTE', left ? 'right' : 'left'); });
      // golfari
      lugs.forEach(l => { const lp = pm(l.L); if (k === 'front') { const a = 0.275 * k2, hh = 0.3 * k2; Ln([lp[0] - a, lp[1]], [lp[0] + a, lp[1]], 'GOLFARI', 0.35); Ln([lp[0] - a, lp[1]], [lp[0] - a * 0.4, lp[1] + hh], 'GOLFARI', 0.35); Ln([lp[0] + a, lp[1]], [lp[0] + a * 0.4, lp[1] + hh], 'GOLFARI', 0.35); Ln([lp[0] - a * 0.4, lp[1] + hh], [lp[0] + a * 0.4, lp[1] + hh], 'GOLFARI', 0.35); }
        else { C(lp, Math.max(0.8, 0.12 * k2), 'GOLFARI'); } });
      // gancio
      C(hp, 1.6, 'FUNI'); Ln([hp[0], hp[1] + 1.6], [hp[0], hp[1] + 6], 'FUNI', 0.35);
      if (k !== 'plan') T([hp[0] + 2.5, hp[1] + 4], `Gancio gru  z ${nf(d.hook[2], 2)}`, 2.2, 'FUNI');
      cogSym(cp, 2.0); T([cp[0] + 3, cp[1] - 3], `COG = ${nf(d.weight, 1)} t`, 2.3, 'BARICENTRO');
      // quote
      const hd = (xa, xb, y, txt) => { Ln([xa, y], [xb, y], 'QUOTE', 0.18); Ln([xa, y - 1.3], [xa, y + 1.3], 'QUOTE', 0.18); Ln([xb, y - 1.3], [xb, y + 1.3], 'QUOTE', 0.18); T([(xa + xb) / 2, y + 1], txt, 2.1, 'QUOTE', 'center'); };
      const vd = (ya, yb, x, txt) => { Ln([x, ya], [x, yb], 'QUOTE', 0.18); Ln([x - 1.3, ya], [x + 1.3, ya], 'QUOTE', 0.18); Ln([x - 1.3, yb], [x + 1.3, yb], 'QUOTE', 0.18); T([x + 1.5, (ya + yb) / 2], txt, 2.1, 'QUOTE'); };
      if (k === 'front') {
        const yq = Math.max(...lugs.map(l => pm(l.L)[1])) + 4;
        clusters(lugs.map(l => l.L[0])).forEach(c => { const x = pm([c.v, 0, 0])[0]; hd(Math.min(x, cp[0]), Math.max(x, cp[0]), yq, c.txt); });
        const lz = pm(lugs[0].L); vd(lz[1], hp[1], hp[0] - 10, mm(hook[2] - lugs[0].L[2]));
      }
      if (k === 'plan') {
        const xq = Math.max(...lugs.map(l => pm(l.L)[0])) + 8;
        clusters(lugs.map(l => l.L[1])).forEach(c => { const y = pm([0, c.v, 0])[1]; vd(Math.min(y, cp[1]), Math.max(y, cp[1]), xq, c.txt); });
        const yq = Math.min(...lugs.map(l => pm(l.L)[1])) - 8;
        clusters(lugs.map(l => l.L[0])).forEach(c => { const x = pm([c.v, 0, 0])[0]; hd(Math.min(x, cp[0]), Math.max(x, cp[0]), yq, c.txt); });
      }
      if (k === 'side') { const yq = Math.max(...lugs.map(l => pm(l.L)[1])) + 4;
        clusters(lugs.map(l => l.L[1])).forEach(c => { const x = pm([0, c.v, 0])[0]; hd(Math.min(x, cp[0]), Math.max(x, cp[0]), yq, c.txt); }); }
    }
    place('front'); place('plan'); place('side');
    // tabella golfari e funi
    const t = R.tab, x0 = t[0] + 2; let y = t[1] + t[3] - 5;
    T([x0, y], 'GOLFARI E FUNI', 2.8); y -= 6;
    const cols = [0, 9, 20, 34, 46, 58, 76];
    ['', 'Trave', 'Carico t', 'Tiro t', 'Angolo', 'Fune m', 'Golfare / grillo'].forEach((h, i) => T([x0 + cols[i], y], h, 1.9)); y -= 2; Ln([x0, y], [t[0] + t[2] - 2, y], 'CORNICE', 0.13); y -= 3.5;
    lugs.forEach((l, i) => { const row = ['F' + (i + 1), l.g || '', nf(l.P, 1), nf(l.T, 1), nf(l.alpha, 1) + '°', nf(l.Ls, 2)];
      row.forEach((v, j) => T([x0 + cols[j], y], v, 2.1)); T([x0 + cols[6], y], (l.type || '–'), 1.9); T([x0 + cols[6], y - 3], (l.shackle || ''), 1.7); y -= 7.5; });
    y -= 2; T([x0, y], `Tiro max ${nf(Math.max(...lugs.map(l => l.T)), 1)} t${d.fd && d.fd !== 1 ? ' (coeff. dinamico ' + nf(d.fd, 2) + ' incluso)' : ''}`, 2.2); y -= 5;
    T([x0, y], `Gancio sopra il baricentro, quota ${nf(d.hook[2], 2)} m`, 2.0); y -= 4.5;
    T([x0, y], 'Ripartizione statica dei carichi: valori da verificare.', 1.8);
    // cartiglio
    const ty = 8, th = 38; rect(12, ty, 396, th, 'CORNICE', 0.35); Ln([250, ty], [250, ty + th], 'CORNICE', 0.25);
    T([14, ty + th - 6], `SCHEMA DI SOLLEVAMENTO CON GRU SINGOLA – ${d.name}`, 3.4);
    T([14, ty + th - 13], `Peso ${nf(d.weight, 2)} t · ${lugs.length} golfari · scala 1:${S} su A3`, 2.5);
    T([14, ty + th - 19], `COG nel modello  X ${nf(c0[0], 3)}  Y ${nf(c0[1], 3)}  Z ${nf(c0[2], 3)} m`, 2.3);
    T([14, ty + th - 25], 'Quote in mm dall\'asse del baricentro. Funi dal foro del golfare al gancio.', 2.0);
    T([252, ty + th - 6], d.project || '', 2.6); T([252, ty + th - 12], d.model || '', 2.0); T([252, ty + th - 18], `Gruppo: ${d.group || ''}`, 2.3);
    T([252, ty + th - 24], `Data ${new Date().toLocaleDateString('it-IT')}`, 2.2); T([252, ty + 3], 'Peso e baricentro · Golfari · Trimble Connect', 2.0);
    return {prims: P, scale: S};
  }

  // ------------------------------------------------------------------ IFC di funi, golfari, gancio e baricentro
  function lugIfc(d) {
    const out = []; let n = 0; const add = s => { n++; out.push(`#${n}=${s};`); return `#${n}`; };
    const G64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
    const guid = () => { let s = G64[Math.floor(Math.random() * 4)]; for (let i = 0; i < 21; i++) s += G64[Math.floor(Math.random() * 64)]; return s; };
    const str = s => `'${String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/[^\x20-\x7e]/g, ch => { const c = ch.charCodeAt(0); return c < 256 ? `\\X\\${c.toString(16).toUpperCase().padStart(2, '0')}` : `\\X2\\${c.toString(16).toUpperCase().padStart(4, '0')}\\X0\\`; })}'`;
    const o = d.origin; // metri, punto di inserimento del sito
    const mmf = v => (Math.round(v * 10000) / 10).toFixed(1);
    const pt = (p) => `(${mmf(p[0] - o[0])},${mmf(p[1] - o[1])},${mmf(p[2] - o[2])})`;
    const p0 = add('IFCCARTESIANPOINT((0.,0.,0.))'), dz = add('IFCDIRECTION((0.,0.,1.))'), dx = add('IFCDIRECTION((1.,0.,0.))'), a0 = add(`IFCAXIS2PLACEMENT3D(${p0},${dz},${dx})`);
    const ctx = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${a0},$)`), body = add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${ctx},$,.MODEL_VIEW.,$)`);
    const units = add(`IFCUNITASSIGNMENT((${add('IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)')},${add('IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)')},${add('IFCSIUNIT(*,.MASSUNIT.,.KILO.,.GRAM.)')}))`);
    const proj = add(`IFCPROJECT('${guid()}',$,${str(d.project || 'Sollevamento')},${str('Schema di sollevamento - ' + d.name)},$,$,$,(${ctx}),${units})`);
    const sp = add(`IFCCARTESIANPOINT((${(o[0] * 1000).toFixed(1)},${(o[1] * 1000).toFixed(1)},${(o[2] * 1000).toFixed(1)}))`);
    const spl = add(`IFCLOCALPLACEMENT($,${add(`IFCAXIS2PLACEMENT3D(${sp},${dz},${dx})`)})`);
    const site = add(`IFCSITE('${guid()}',$,'Sollevamento',$,$,${spl},$,$,.ELEMENT.,$,$,$,$,$)`);
    add(`IFCRELAGGREGATES('${guid()}',$,$,$,${proj},(${site}))`);
    const pl = add(`IFCLOCALPLACEMENT(${spl},${a0})`);
    const styles = {}; const style = hex => { if (styles[hex]) return styles[hex]; const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
      const col = add(`IFCCOLOURRGB($,${r.toFixed(3)},${g.toFixed(3)},${b.toFixed(3)})`); return styles[hex] = add(`IFCSURFACESTYLE($,.BOTH.,(${add(`IFCSURFACESTYLESHADING(${col},0.)`)}))`); };
    const shape = (V, F, hex) => { const pl3 = add(`IFCCARTESIANPOINTLIST3D((${V.map(pt).join(',')}))`); const fs = add(`IFCTRIANGULATEDFACESET(${pl3},$,.T.,(${F.map(f => `(${f[0] + 1},${f[1] + 1},${f[2] + 1})`).join(',')}),$)`);
      add(`IFCSTYLEDITEM(${fs},(${style(hex)}),$)`); return add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${add(`IFCSHAPEREPRESENTATION(${body},'Body','Tessellation',(${fs}))`)}))`); };
    const pset = (obj, name, props) => { const ps = props.map(([k, v]) => add(`IFCPROPERTYSINGLEVALUE(${str(k)},$,${typeof v === 'number' ? `IFCREAL(${v.toFixed(3)})` : `IFCLABEL(${str(v)})`},$)`)); add(`IFCRELDEFINESBYPROPERTIES('${guid()}',$,$,$,(${obj}),${add(`IFCPROPERTYSET('${guid()}',$,${str(name)},$,(${ps.join(',')}))`)})`); };
    const proxy = (name, type, V, F, hex, props) => { const e = add(`IFCBUILDINGELEMENTPROXY('${guid()}',$,${str(name)},$,${str(type)},${pl},${shape(V, F, hex)},${str(name)},.NOTDEFINED.)`); if (props) pset(e, 'Sollevamento', props); return e; };
    // primitive
    const tube = (a, b, r, seg = 12) => { const ax = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]); let t = Math.abs(ax[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]; const u = norm(cross(ax, t)), w = cross(ax, u); const V = [], F = [];
      for (let i = 0; i < seg; i++) { const an = i / seg * Math.PI * 2, c = Math.cos(an) * r, s = Math.sin(an) * r; V.push([a[0] + u[0] * c + w[0] * s, a[1] + u[1] * c + w[1] * s, a[2] + u[2] * c + w[2] * s]); V.push([b[0] + u[0] * c + w[0] * s, b[1] + u[1] * c + w[1] * s, b[2] + u[2] * c + w[2] * s]); }
      for (let i = 0; i < seg; i++) { const j = (i + 1) % seg; F.push([2 * i, 2 * j, 2 * i + 1], [2 * j, 2 * j + 1, 2 * i + 1]); }
      const ca = V.length; V.push(a); const cb = V.length; V.push(b); for (let i = 0; i < seg; i++) { const j = (i + 1) % seg; F.push([ca, 2 * j, 2 * i], [cb, 2 * i + 1, 2 * j + 1]); }
      return [V, F]; };
    const prism = (base, h) => { // base: poligono convesso [[x,y,z]...] estruso lungo il vettore h
      const nb = base.length, V = [...base, ...base.map(p => [p[0] + h[0], p[1] + h[1], p[2] + h[2]])], F = [];
      for (let i = 1; i < nb - 1; i++) { F.push([0, i + 1, i]); F.push([nb, nb + i, nb + i + 1]); }
      for (let i = 0; i < nb; i++) { const j = (i + 1) % nb; F.push([i, j, nb + j], [i, nb + j, nb + i]); }
      return [V, F]; };
    const box = (c, sx, sy, sz) => prism([[c[0] - sx / 2, c[1] - sy / 2, c[2] - sz / 2], [c[0] + sx / 2, c[1] - sy / 2, c[2] - sz / 2], [c[0] + sx / 2, c[1] + sy / 2, c[2] - sz / 2], [c[0] - sx / 2, c[1] + sy / 2, c[2] - sz / 2]], [0, 0, sz]);
    const items = [];
    const ax = [d.ax[0], d.ax[1], 0], pv = [-d.ax[1], d.ax[0], 0];
    d.lugs.forEach((l, i) => {
      const L = d.lugL || 0.55, Hh = 0.3, th = 0.035, hole = [l.x, l.y, l.z + 0.16];
      const P = (u, z) => [l.x + ax[0] * u - pv[0] * th / 2, l.y + ax[1] * u - pv[1] * th / 2, l.z + z];
      const [V, F] = prism([P(-L / 2, 0), P(L / 2, 0), P(L * 0.2, Hh), P(-L * 0.2, Hh)], [pv[0] * th, pv[1] * th, 0]);
      items.push(proxy(`Golfare F${i + 1}`, l.type || 'Golfare', V, F, '#e2a900', [['Tiro_t', l.T], ['Carico_t', l.P], ['Tipo', l.type || ''], ['Grillo', l.shackle || ''], ['Trave', l.g || '']]));
      const [V2, F2] = tube(hole, d.hook, d.slingR || 0.03);
      items.push(proxy(`Fune F${i + 1}`, 'Fune di sollevamento', V2, F2, '#1f5fbf', [['Tiro_t', l.T], ['Lunghezza_m', l.Ls], ['Angolo_deg', l.alpha], ['Golfare', `F${i + 1}`]]));
    });
    const [Vh, Fh] = box([d.hook[0], d.hook[1], d.hook[2] + 0.4], 0.6, 0.4, 0.8);
    items.push(proxy('Gancio gru', 'Gancio', Vh, Fh, '#c0392b', [['Quota_m', d.hook[2]], ['Peso_sollevato_t', d.weight]]));
    const s = 0.4, c = d.cog, oct = [[c[0] + s, c[1], c[2]], [c[0] - s, c[1], c[2]], [c[0], c[1] + s, c[2]], [c[0], c[1] - s, c[2]], [c[0], c[1], c[2] + s], [c[0], c[1], c[2] - s]];
    items.push(proxy('COG ' + d.name, 'Baricentro', oct, [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]], '#d62728', [['Peso_t', d.weight], ['X', c[0]], ['Y', c[1]], ['Z', c[2]]]));
    add(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid()}',$,$,$,(${items.join(',')}),${site})`);
    return `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');\nFILE_NAME(${str(d.name + '_sollevamento.ifc')},'${new Date().toISOString().slice(0, 19)}',(''),(''),'Peso e baricentro','Peso e baricentro','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n` + out.join('\n') + '\nENDSEC;\nEND-ISO-10303-21;\n';
  }

  const API = {buildLugSheet, lugIfc, liftModel, placeLugs, slingForces, IFC, toDxfMulti, initIfc, openIfc, meshOf, leaves, volCentroid, bboxOf, buildSheet, toPdf, toDxf, featureEdges, hiddenLine};
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.PBDraw = API;
})(typeof window !== 'undefined' ? window : globalThis);
