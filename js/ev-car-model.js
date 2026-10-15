/*
 * ev-car-model.js
 * ---------------------------------------------------------------------------
 * Procedural *premium electric sedan* built entirely from Three.js geometry
 * and materials — no external GLB/GLTF asset is required at runtime.
 *
 * Visual target (see design notes below):
 *   - one continuous, smooth, enclosed four-door sedan body (hood -> windshield
 *     -> roof -> rear window -> trunk is a single lofted surface, so there is
 *     no "raised cabin" seam),
 *   - deep translucent blue paint that still reads as a SOLID car,
 *   - thin, controlled cyan technical contour lines as a SECONDARY layer
 *     (never a full wireframe),
 *   - dark rubber tyres + dark metallic rims,
 *   - visible windows, head/tail lights, mirrors, wheel arches, door seams,
 *   - internal EV systems (battery / motor / BMS / VCU / thermal) glowing
 *     softly through the translucent blue shell.
 *
 * Exposes a single factory: buildEVCar()
 *   -> { root, components, pickables, materials, setCutaway, dispose, dimensions }
 *
 * ---------------------------------------------------------------------------
 * BODY CONSTRUCTION
 * ---------------------------------------------------------------------------
 * The whole body (including the greenhouse) is generated as ONE lofted surface:
 *
 *   1. Three monotone-cubic tables describe the silhouette as a function of the
 *      longitudinal position x: topY(x), bottomY(x) and halfTaper(x).
 *   2. At every station x, sectionControl(x) returns 16 control points in the
 *      (z, y) plane describing a proper car cross-section:
 *          floor -> inner wheel well -> wheel arch -> rocker -> shoulder
 *          (max width, the beltline) -> tumblehome -> crowned roof.
 *   3. A closed CatmullRom curve is sampled through those controls and the
 *      stations are stitched into an indexed BufferGeometry.
 *
 * Wheel arches are cut into the *outer* part of the section only, so the flat
 * cabin floor is preserved for the battery pack while the wheels still sit in
 * proper wells.
 *
 * Windows, light bars, mirrors, door seams and the beltline are then placed
 * exactly ON that surface using the same section curves (sectionSurfacePoint),
 * so nothing can float.
 *
 * This is a *conceptual* digital-twin visualisation, not an engineering CAD
 * model. Component placement is illustrative but physically plausible.
 */

import * as THREE from 'three';

/* -------------------------------------------------------------------------- */
/* Dimensions (metres). +X forward, +Y up, Z across the car.                  */
/* -------------------------------------------------------------------------- */
const DIMS = Object.freeze({
  length: 4.88,
  width: 1.9,
  height: 1.5,
  wheelRadius: 0.34,
  wheelWidth: 0.24,
  frontAxle: 1.42,
  rearAxle: -1.42,
  halfTrack: 0.76,
  floorY: 0.3,
  noseX: 2.44,
  tailX: -2.44
});

export const COMPONENT_COLORS = Object.freeze({
  battery: 0x18e0c0, // turquoise
  motor: 0x2ec5ff,   // cyan
  thermal: 0x9d7bff, // purple
  bms: 0xf0c04a,     // amber
  vcu: 0x5aa0ff      // blue
});

export const COMPONENT_LABELS = Object.freeze({
  battery: 'Battery Pack',
  motor: 'Motor Controller',
  thermal: 'Thermal System',
  bms: 'BMS',
  vcu: 'VCU'
});

const BODY_HALF_W = 0.95;   // maximum half width (shoulder line)
const ARCH_R = 0.5;          // wheel-arch circle radius
const ARCH_LIFT_CAP = 0.44;  // keeps a real fender band above every wheel
const SECTION_SAMPLES = 80;  // points sampled around one cross-section
const STATION_STEP = 0.07;   // metres between cross-sections
const CONTROL_COUNT = 16;    // control points in one cross-section

/* -------------------------------------------------------------------------- */
/* Math helpers                                                               */
/* -------------------------------------------------------------------------- */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Monotone cubic (PCHIP) interpolator over [x, y] anchors.
 * Guarantees the curve passes through every anchor with no overshoot and a
 * continuous first derivative — essential so the lofted body has no creases.
 */
function makeTable(anchors) {
  const pts = anchors.slice().sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  const xs = pts.map(p => p[0]);
  const ys = pts.map(p => p[1]);
  const h = [];
  const d = [];
  const m = new Array(n);

  for (let i = 0; i < n - 1; i++) {
    h[i] = xs[i + 1] - xs[i];
    d[i] = (ys[i + 1] - ys[i]) / h[i];
  }

  m[0] = d[0];
  m[n - 1] = d[n - 2];

  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) {
      m[i] = 0;
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }

  return function read(x) {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];

    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid;
    }

    const t = (x - xs[lo]) / h[lo];
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;

    return h00 * ys[lo] + h10 * h[lo] * m[lo] + h01 * ys[lo + 1] + h11 * h[lo] * m[lo + 1];
  };
}

/* -------------------------------------------------------------------------- */
/* Silhouette tables                                                          */
/* -------------------------------------------------------------------------- */

/** Roofline: nose -> hood -> windshield -> roof -> rear window -> trunk. */
const topYAt = makeTable([
  [-2.44, 0.64], [-2.42, 0.8], [-2.34, 0.9], [-2.24, 0.965], [-2.1, 0.998],
  [-1.86, 1.012], [-1.58, 1.022], [-1.36, 1.045], [-1.2, 1.095], [-1.0, 1.205],
  [-0.8, 1.31], [-0.6, 1.395], [-0.42, 1.43], [-0.14, 1.442], [0.16, 1.44],
  [0.36, 1.412], [0.46, 1.35], [0.58, 1.245], [0.72, 1.13], [0.88, 1.02],
  [1.02, 0.955], [1.24, 0.935], [1.48, 0.918], [1.72, 0.898], [1.95, 0.868],
  [2.12, 0.825], [2.26, 0.76], [2.36, 0.68], [2.42, 0.6], [2.44, 0.55]
]);

/** Underbody: flat cabin floor, bumpers curling up at both ends. */
const bottomYAt = makeTable([
  [-2.44, 0.6], [-2.42, 0.46], [-2.36, 0.355], [-2.26, 0.315], [-2.14, 0.3],
  [2.14, 0.3], [2.26, 0.315], [2.36, 0.355], [2.42, 0.46], [2.44, 0.51]
]);

/** Lateral taper: full width between the axles, rounded nose and tail. */
const taperAt = makeTable([
  [-2.44, 0.03], [-2.42, 0.13], [-2.36, 0.33], [-2.26, 0.56], [-2.12, 0.78],
  [-1.95, 0.895], [-1.76, 0.955], [-1.55, 0.985], [-1.3, 1.0],
  [1.3, 1.0], [1.55, 0.985], [1.76, 0.955], [1.95, 0.895], [2.12, 0.78],
  [2.26, 0.56], [2.36, 0.33], [2.42, 0.12], [2.44, 0.03]
]);

/** Height of the wheel well at this station (0 outside the arches). */
function archLiftAt(x) {
  let lift = 0;
  [DIMS.frontAxle, DIMS.rearAxle].forEach(axle => {
    const dx = Math.abs(x - axle);
    if (dx < ARCH_R) lift = Math.max(lift, Math.sqrt(ARCH_R * ARCH_R - dx * dx));
  });
  return Math.min(lift, ARCH_LIFT_CAP);
}

function halfWidthAt(x) {
  return BODY_HALF_W * taperAt(x);
}

function crownAt(t) {
  return 0.02 + 0.03 * smoothstep(1.05, 1.35, t);
}

/* -------------------------------------------------------------------------- */
/* Cross-section construction                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 16 control points of the closed (z, y) cross-section at station `x`,
 * ordered bottom-centre -> right flank -> crowned roof -> left flank.
 *
 * Control index -> section parameter u is k / 16 (used by the detail layers):
 *   k0 floor centre   k4 rocker   k5 shoulder/beltline   k6 upper flank
 *   k7 roof edge      k8 roof centre (mirror continues k9..k15)
 */
function sectionControl(x) {
  const b = bottomYAt(x);
  const t = Math.max(topYAt(x), b + 0.06);
  const h = t - b;
  const w = halfWidthAt(x);
  const lift = Math.min(archLiftAt(x), ARCH_LIFT_CAP);

  const glassy = smoothstep(1.0, 1.46, t);           // 0 hood/trunk, 1 cabin
  const roofZf = 0.86 - 0.3 * glassy;                // roof is narrower (tumblehome)
  const upperZf = 0.99 - 0.06 * glassy;

  const rockerY = b + Math.max(0.16 * h, lift + 0.02);
  const shY = b + (0.58 + 0.22 * (1 - glassy)) * h;  // shoulder height
  const sh = clamp(shY, rockerY + 0.006, b + 0.85 * h - 0.01);

  const floorEdge = 0.6 * w;
  const wellInner = 0.63 * w;
  const wellOuter = 0.94 * w;
  const rockerZ = 0.95 * w;
  const crown = crownAt(t);

  return [
    [0, b],
    [floorEdge, b],
    [wellInner, b + lift * 0.95],
    [wellOuter, b + lift],
    [rockerZ, rockerY],
    [w, sh],
    [upperZf * w, b + 0.85 * h],
    [roofZf * w, t - 0.05 * h],
    [0, t + crown],
    [-roofZf * w, t - 0.05 * h],
    [-upperZf * w, b + 0.85 * h],
    [-w, sh],
    [-rockerZ, rockerY],
    [-wellOuter, b + lift],
    [-wellInner, b + lift * 0.95],
    [-floorEdge, b]
  ];
}

function makeSectionCurve(x) {
  const points = sectionControl(x).map(p => new THREE.Vector3(p[0], p[1], 0));
  return new THREE.CatmullRomCurve3(points, true, 'centripetal');
}

/**
 * A point on the section surface at longitudinal position x and curve
 * parameter u, offset `offset` metres along the local outward radial
 * direction (negative values sink into the body). Used to place windows,
 * lights and seams exactly on the body without ever floating off it.
 */
function sectionSurfacePoint(x, u, offset) {
  const b = bottomYAt(x);
  const t = Math.max(topYAt(x), b + 0.06);
  const p = makeSectionCurve(x).getPoint(clamp(u, 0, 1));

  const cy = (b + t) / 2;
  let dz = p.x;
  let dy = p.y - cy;
  const len = Math.hypot(dz, dy);

  if (len > 1e-6) {
    dz /= len;
    dy /= len;
  } else {
    dz = 0;
    dy = p.y >= cy ? 1 : -1;
  }

  return { y: p.y + dy * offset, z: p.x + dz * offset };
}

/* -------------------------------------------------------------------------- */
/* Body geometry (single lofted shell)                                        */
/* -------------------------------------------------------------------------- */
function buildBodyGeometry() {
  const span = DIMS.noseX - DIMS.tailX;
  const stations = [];
  for (let i = 0; i * STATION_STEP <= span + 1e-9; i++) {
    const x = DIMS.noseX - i * STATION_STEP;
    stations.push(x < DIMS.tailX ? DIMS.tailX : x);
  }

  const count = stations.length;
  const N = SECTION_SAMPLES;
  const positions = new Float32Array(count * N * 3);
  const uvs = new Float32Array(count * N * 2);
  const indices = [];

  let probeIndex = -1;
  let probeZ = -Infinity;

  for (let s = 0; s < count; s++) {
    const x = stations[s];
    const curve = makeSectionCurve(x);

    for (let i = 0; i < N; i++) {
      const p = curve.getPoint(i / N);
      const v = s * N + i;
      positions[v * 3] = x;
      positions[v * 3 + 1] = p.y;
      positions[v * 3 + 2] = p.x;
      uvs[v * 2] = i / N;
      uvs[v * 2 + 1] = s / (count - 1);

      // Widest point near the middle of the car -> used to verify normals.
      if (Math.abs(x) < 0.4 && p.x > probeZ) {
        probeZ = p.x;
        probeIndex = v;
      }
    }
  }

  // Stations run nose -> tail (descending x) with the loop counter-clockwise
  // in (z, y), which yields outward-facing normals.
  for (let s = 0; s < count - 1; s++) {
    const a = s * N;
    const b = (s + 1) * N;
    for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      indices.push(a + i, a + j, b + j);
      indices.push(a + i, b + j, b + i);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  // Safety net: if winding came out inverted, flip every triangle.
  if (probeIndex >= 0 && geometry.attributes.normal.getZ(probeIndex) < 0) {
    const idx = geometry.index.array;
    for (let i = 0; i < idx.length; i += 3) {
      const swap = idx[i + 1];
      idx[i + 1] = idx[i + 2];
      idx[i + 2] = swap;
    }
    geometry.index.needsUpdate = true;
    geometry.computeVertexNormals();
  }

  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Move every vertex of a line/edge geometry outward so it can never z-fight
 * with the translucent shell it sits on.
 */
function offsetOutward(geometry, amount) {
  const position = geometry.attributes.position;

  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);

    const cy = (bottomYAt(x) + Math.max(topYAt(x), bottomYAt(x) + 0.06)) / 2;
    let dz = z;
    let dy = y - cy;
    const len = Math.hypot(dz, dy);

    if (len > 1e-6) {
      position.setXYZ(i, x, y + (dy / len) * amount, z + (dz / len) * amount);
    }
  }

  position.needsUpdate = true;
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Light bar: a strip that lies *on* the body surface, running across the
 * station along u (left/right over the nose or tail) with a small width in x.
 * `offset` lifts the strip a few millimetres along the outward normal so it
 * sits just above the paint instead of being buried by the depth buffer.
 */
function buildLightBar(x, uStart, uEnd, width, steps, offset, material) {
  const positions = [];
  const indices = [];

  const at = (xx, u) => {
    const p = sectionSurfacePoint(xx, u, offset);
    return [xx, p.y, p.z];
  };

  const x1 = x - width / 2;
  const x2 = x + width / 2;

  for (let i = 0; i <= steps; i++) {
    const u = lerp(uStart, uEnd, i / steps);
    positions.push(...at(x1, u), ...at(x2, u));
  }

  for (let i = 0; i < steps; i++) {
    const a = i * 2;
    indices.push(a, a + 2, a + 3, a, a + 3, a + 1);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 3;
  return mesh;
}

/**
 * A patch of body surface (windscreen, side glass) described by a section
 * parameter range and a longitudinal range that may itself depend on height
 * (so window edges can rake like A/C pillars).
 */
function buildPatch({ uStart, uEnd, xAt, rows = 6, cols = 10, offset = 0.01, mirror = false }) {
  const positions = [];
  const indices = [];

  for (let r = 0; r <= rows; r++) {
    const v = r / rows;
    const u = lerp(uStart, uEnd, v);

    for (let c = 0; c <= cols; c++) {
      const s = c / cols;
      const x = xAt(v, s);
      const p = sectionSurfacePoint(x, u, offset);
      positions.push(x, p.y, mirror ? -p.z : p.z);
    }
  }

  const stride = cols + 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = r * stride + c;
      const b = a + 1;
      const d = (r + 1) * stride + c;
      const e = d + 1;
      indices.push(a, d, e, a, e, b);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** A polyline sampled along one section parameter, across many stations. */
function sampleAlong(xStart, xEnd, step, uFn, offset) {
  const points = [];
  const dir = xEnd >= xStart ? 1 : -1;
  for (let x = xStart; dir > 0 ? x <= xEnd + 1e-6 : x >= xEnd - 1e-6; x += dir * step) {
    const p = sectionSurfacePoint(x, uFn(x), offset);
    points.push(new THREE.Vector3(x, p.y, p.z));
  }
  return points;
}

/** A short line sampled along one station (door seam). */
function sampleUpSection(x, uStart, uEnd, steps, offset) {
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const p = sectionSurfacePoint(x, lerp(uStart, uEnd, i / steps), offset);
    points.push(new THREE.Vector3(x, p.y, p.z));
  }
  return points;
}

/** Convert polylines into one LineSegments geometry. */
function segmentsFromPolylines(polylines) {
  const positions = [];
  polylines.forEach(points => {
    for (let i = 0; i < points.length - 1; i++) {
      positions.push(
        points[i].x, points[i].y, points[i].z,
        points[i + 1].x, points[i + 1].y, points[i + 1].z
      );
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/* -------------------------------------------------------------------------- */
/* Wheels                                                                     */
/* -------------------------------------------------------------------------- */
function buildWheel(materials, x, z) {
  const { wheelRadius: R, wheelWidth: W } = DIMS;
  const group = new THREE.Group();

  const tire = new THREE.Mesh(
    new THREE.CylinderGeometry(R, R, W, 40, 1, false),
    materials.tire
  );
  tire.rotation.x = Math.PI / 2;
  tire.castShadow = true;
  group.add(tire);

  // Subtle sidewall shoulder.
  const shoulder = new THREE.Mesh(
    new THREE.TorusGeometry(R * 0.94, 0.028, 8, 40),
    materials.tire
  );
  shoulder.position.z = (z > 0 ? 1 : -1) * W * 0.5;
  group.add(shoulder);

  const outer = z > 0 ? 1 : -1;

  const rim = new THREE.Mesh(
    new THREE.CylinderGeometry(R * 0.67, R * 0.67, W * 0.96, 32),
    materials.rim
  );
  rim.rotation.x = Math.PI / 2;
  group.add(rim);

  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(R * 0.55, R * 0.55, W * 0.5, 24),
    materials.trim
  );
  disc.rotation.x = Math.PI / 2;
  group.add(disc);

  // Ten slim spokes: five structural + five accent for a premium rim face.
  for (let i = 0; i < 10; i++) {
    const angle = (i / 10) * Math.PI * 2;
    const accent = i % 2 === 1;
    const spoke = new THREE.Mesh(
      new THREE.BoxGeometry(R * (accent ? 0.46 : 0.78), accent ? 0.03 : 0.05, 0.026),
      accent ? materials.hub : materials.rim
    );
    spoke.position.set(
      Math.cos(angle) * R * (accent ? 0.34 : 0.36),
      Math.sin(angle) * R * (accent ? 0.34 : 0.36),
      outer * W * 0.47
    );
    spoke.rotation.z = angle;
    group.add(spoke);
  }

  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(R * 0.17, R * 0.17, W * 1.06, 20),
    materials.hub
  );
  hub.rotation.x = Math.PI / 2;
  group.add(hub);

  group.position.set(x, R, z);
  return group;
}

/* -------------------------------------------------------------------------- */
/* Internal EV components                                                     */
/* -------------------------------------------------------------------------- */
function makeComponent(id, label, baseColor, options = {}) {
  const group = new THREE.Group();
  group.name = 'component-' + id;
  group.userData.componentId = id;

  const surface = new THREE.MeshStandardMaterial({
    color: options.color || 0x101f33,
    metalness: options.metalness !== undefined ? options.metalness : 0.5,
    roughness: options.roughness !== undefined ? options.roughness : 0.45,
    emissive: new THREE.Color(baseColor),
    emissiveIntensity: 0.42,
    transparent: !!options.translucent,
    opacity: options.translucent ? 0.86 : 1,
    depthWrite: !options.translucent
  });

  const accent = new THREE.MeshStandardMaterial({
    color: 0x08131f,
    metalness: 0.3,
    roughness: 0.55,
    emissive: new THREE.Color(baseColor),
    emissiveIntensity: 0.95
  });

  return {
    id,
    label,
    baseColor: new THREE.Color(baseColor),
    group,
    surface,
    accent,
    meshes: [],
    mainMesh: null,
    outline: null
  };
}

function addMesh(component, geometry, material, position, rotation) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.componentId = component.id;

  if (position) mesh.position.set(position[0], position[1], position[2]);
  if (rotation) mesh.rotation.set(rotation[0], rotation[1], rotation[2]);

  component.group.add(mesh);
  component.meshes.push(mesh);
  if (!component.mainMesh) component.mainMesh = mesh;
  return mesh;
}

function roundedBoxGeometry(width, height, depth, radius = 0.04, segments = 3) {
  const shape = new THREE.Shape();
  const x = -width / 2;
  const y = -height / 2;
  const r = Math.min(radius, Math.min(width, height) / 2.2);

  shape.moveTo(x + r, y);
  shape.lineTo(x + width - r, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + r);
  shape.lineTo(x + width, y + height - r);
  shape.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  shape.lineTo(x + r, y + height);
  shape.quadraticCurveTo(x, y + height, x, y + height - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: Math.min(r, 0.02),
    bevelSize: Math.min(r, 0.02),
    bevelSegments: segments,
    curveSegments: segments
  });

  geometry.translate(0, 0, -depth / 2);
  geometry.computeVertexNormals();
  return geometry;
}

function buildBattery() {
  const battery = makeComponent(
    'battery',
    COMPONENT_LABELS.battery,
    COMPONENT_COLORS.battery,
    { color: 0x0c3d40, translucent: true, metalness: 0.25, roughness: 0.5 }
  );

  // Long, flat pack under the cabin floor.
  addMesh(battery, roundedBoxGeometry(2.55, 0.14, 1.06, 0.05), battery.surface, [0, 0.44, 0]);

  for (let i = 0; i < 13; i++) {
    addMesh(
      battery,
      new THREE.BoxGeometry(0.05, 0.1, 0.92),
      battery.accent,
      [-1.14 + i * 0.19, 0.44, 0]
    );
  }

  [-1, 1].forEach(side => {
    addMesh(battery, new THREE.BoxGeometry(2.4, 0.02, 0.035), battery.accent, [0, 0.5, side * 0.47]);
  });

  return battery;
}

function buildMotor() {
  const motor = makeComponent(
    'motor',
    COMPONENT_LABELS.motor,
    COMPONENT_COLORS.motor
  );

  addMesh(
    motor,
    new THREE.CylinderGeometry(0.17, 0.17, 0.34, 30),
    motor.surface,
    [-1.42, 0.5, 0],
    [0, 0, Math.PI / 2]
  );

  for (let i = 0; i < 4; i++) {
    addMesh(
      motor,
      new THREE.CylinderGeometry(0.185, 0.185, 0.014, 24),
      motor.accent,
      [-1.54 + i * 0.075, 0.5, 0],
      [0, 0, Math.PI / 2]
    );
  }

  // Motor controller / inverter above the drive unit.
  addMesh(motor, roundedBoxGeometry(0.4, 0.15, 0.4, 0.04), motor.surface, [-1.26, 0.7, 0]);
  addMesh(motor, new THREE.BoxGeometry(0.3, 0.018, 0.3), motor.accent, [-1.26, 0.79, 0]);

  return motor;
}

function buildBms() {
  const bms = makeComponent('bms', COMPONENT_LABELS.bms, COMPONENT_COLORS.bms);

  addMesh(bms, roundedBoxGeometry(0.36, 0.09, 0.28, 0.03), bms.surface, [0.5, 0.6, 0.26]);

  for (let i = 0; i < 4; i++) {
    addMesh(bms, new THREE.BoxGeometry(0.04, 0.04, 0.1), bms.accent, [0.38 + i * 0.08, 0.65, 0.26]);
  }

  return bms;
}

function buildVcu() {
  const vcu = makeComponent('vcu', COMPONENT_LABELS.vcu, COMPONENT_COLORS.vcu);

  addMesh(vcu, roundedBoxGeometry(0.3, 0.09, 0.24, 0.03), vcu.surface, [0.86, 0.64, -0.24]);
  addMesh(vcu, new THREE.BoxGeometry(0.2, 0.015, 0.16), vcu.accent, [0.86, 0.69, -0.24]);

  return vcu;
}

function buildThermal() {
  const thermal = makeComponent(
    'thermal',
    COMPONENT_LABELS.thermal,
    COMPONENT_COLORS.thermal
  );

  // Coolant loop hugging the pack perimeter.
  const loop = new THREE.CatmullRomCurve3(
    [
      new THREE.Vector3(1.25, 0.53, 0.54),
      new THREE.Vector3(0, 0.53, 0.54),
      new THREE.Vector3(-1.25, 0.53, 0.54),
      new THREE.Vector3(-1.3, 0.53, 0),
      new THREE.Vector3(-1.25, 0.53, -0.54),
      new THREE.Vector3(0, 0.53, -0.54),
      new THREE.Vector3(1.25, 0.53, -0.54),
      new THREE.Vector3(1.3, 0.53, 0)
    ],
    true,
    'catmullrom',
    0.4
  );

  addMesh(thermal, new THREE.TubeGeometry(loop, 110, 0.022, 8, true), thermal.accent);

  addMesh(
    thermal,
    new THREE.CylinderGeometry(0.07, 0.07, 0.09, 18),
    thermal.surface,
    [1.28, 0.53, 0.54],
    [Math.PI / 2, 0, 0]
  );

  // Front radiator + two feed hoses running back to the loop.
  addMesh(thermal, roundedBoxGeometry(0.07, 0.26, 0.7, 0.02), thermal.surface, [2.0, 0.55, 0]);

  for (let i = 0; i < 5; i++) {
    addMesh(thermal, new THREE.BoxGeometry(0.015, 0.2, 0.015), thermal.accent, [1.99, 0.55, -0.24 + i * 0.12]);
  }

  [1, -1].forEach(side => {
    const hose = new THREE.CatmullRomCurve3([
      new THREE.Vector3(1.94, 0.5, side * 0.3),
      new THREE.Vector3(1.7, 0.52, side * 0.42),
      new THREE.Vector3(1.45, 0.53, side * 0.5),
      new THREE.Vector3(1.3, 0.53, side * 0.54)
    ]);
    addMesh(thermal, new THREE.TubeGeometry(hose, 24, 0.018, 8, false), thermal.surface);
  });

  return thermal;
}

/* -------------------------------------------------------------------------- */
/* Surface detail helpers                                                     */
/* -------------------------------------------------------------------------- */
function buildSurfaceLine(xStart, xEnd, step, uFn, inset, material) {
  const geometry = segmentsFromPolylines([sampleAlong(xStart, xEnd, step, uFn, inset)]);
  return new THREE.LineSegments(geometry, material);
}

function buildSurfacePatch(props, material, outlineMaterial) {
  const geometry = buildPatch(props);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 3;

  if (outlineMaterial) {
    const outline = new THREE.LineSegments(
      offsetOutward(new THREE.EdgesGeometry(geometry, 18), 0.004),
      outlineMaterial
    );
    outline.renderOrder = 4;
    mesh.add(outline);
  }

  return mesh;
}

/* -------------------------------------------------------------------------- */
/* Main factory                                                               */
/* -------------------------------------------------------------------------- */
export function buildEVCar() {
  const root = new THREE.Group();
  root.name = 'EvCar';

  /* ---------------------------------------------------------------- */
  /* Materials                                                        */
  /* ---------------------------------------------------------------- */

  // Deep electric-blue paint: mostly solid, only partly see-through.
  const shell = new THREE.MeshPhysicalMaterial({
    color: 0x1554a8,
    metalness: 0.3,
    roughness: 0.34,
    clearcoat: 0.7,
    clearcoatRoughness: 0.24,
    emissive: new THREE.Color(0x08264f),
    emissiveIntensity: 0.14,
    envMapIntensity: 0.75,
    transparent: true,
    opacity: 0.6,
    depthWrite: true,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1
  });

  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x061426,
    metalness: 0.2,
    roughness: 0.08,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
    envMapIntensity: 1.0,
    transparent: true,
    opacity: 0.62,
    depthWrite: false,
    side: THREE.DoubleSide
  });

  // Secondary technical layer — thin, controlled, never additive.
  const contour = new THREE.LineBasicMaterial({
    color: 0x5ec8ff,
    transparent: true,
    opacity: 0.42,
    depthWrite: false
  });

  const trim = new THREE.MeshStandardMaterial({
    color: 0x0a1119,
    metalness: 0.35,
    roughness: 0.7,
    envMapIntensity: 0.4
  });

  const tire = new THREE.MeshStandardMaterial({
    color: 0x090c11,
    metalness: 0.02,
    roughness: 0.96,
    envMapIntensity: 0.2
  });

  const rim = new THREE.MeshStandardMaterial({
    color: 0x6b7481,
    metalness: 1.0,
    roughness: 0.36,
    envMapIntensity: 0.7
  });

  const hub = new THREE.MeshStandardMaterial({
    color: 0x2b3542,
    metalness: 0.8,
    roughness: 0.42,
    emissive: new THREE.Color(0x0d3f55),
    emissiveIntensity: 0.35
  });

  const headlight = new THREE.MeshStandardMaterial({
    color: 0xcfeaff,
    metalness: 0.1,
    roughness: 0.24,
    emissive: new THREE.Color(0x8fd4ff),
    emissiveIntensity: 0.55,
    side: THREE.DoubleSide
  });

  const taillight = new THREE.MeshStandardMaterial({
    color: 0xff4560,
    metalness: 0.1,
    roughness: 0.25,
    emissive: new THREE.Color(0xff2844),
    emissiveIntensity: 0.75,
    side: THREE.DoubleSide
  });

  const materials = { shell, glass, contour, trim, tire, rim, hub, headlight, taillight };

  /* ---------------------------------------------------------------- */
  /* Body — one continuous lofted shell                               */
  /* ---------------------------------------------------------------- */
  const bodyGeometry = buildBodyGeometry();
  const bodyMesh = new THREE.Mesh(bodyGeometry, shell);
  bodyMesh.name = 'body';
  bodyMesh.castShadow = true;
  bodyMesh.renderOrder = 2;
  root.add(bodyMesh);

  // Feature edges only (no per-triangle wireframe).
  const edges = new THREE.LineSegments(offsetOutward(new THREE.EdgesGeometry(bodyGeometry, 18), 0.014), contour);
  edges.renderOrder = 4;
  root.add(edges);

  /* ---------------------------------------------------------------- */
  /* Glass — windscreen, rear window, four side windows              */
  /* ---------------------------------------------------------------- */
  root.add(buildSurfacePatch(
    { uStart: 0.44, uEnd: 0.56, xAt: (v, s) => lerp(1.0, 0.44, s), rows: 7, cols: 12, offset: 0.010 },
    glass,
    contour
  ));

  root.add(buildSurfacePatch(
    { uStart: 0.44, uEnd: 0.56, xAt: (v, s) => lerp(-0.58, -1.34, s), rows: 7, cols: 12, offset: 0.010 },
    glass,
    contour
  ));

  const SIDE_U_START = 0.319;
  const SIDE_U_END = 0.409;

  // Front side windows: raked front edge follows the A-pillar.
  root.add(buildSurfacePatch(
    {
      uStart: SIDE_U_START, uEnd: SIDE_U_END,
      xAt: (v, s) => lerp(0.035, lerp(0.94, 0.5, v), s),
      rows: 5, cols: 9, offset: 0.010
    },
    glass,
    contour
  ));

  // Rear side windows: raked rear edge follows the C-pillar.
  root.add(buildSurfacePatch(
    {
      uStart: SIDE_U_START, uEnd: SIDE_U_END,
      xAt: (v, s) => lerp(lerp(-0.94, -1.3, v), -0.035, s),
      rows: 5, cols: 9, offset: 0.010
    },
    glass,
    contour
  ));

  // B-pillar bridges the gap between front and rear glass so the side reads
  // as two doors per flank rather than one long coupe window.
  [false, true].forEach(mirror => {
    root.add(buildSurfacePatch(
      {
        uStart: SIDE_U_START, uEnd: SIDE_U_END,
        xAt: (v, s) => lerp(-0.035, 0.035, s),
        rows: 3, cols: 3, offset: 0.0115, mirror
      },
      trim,
      contour
    ));
  });

  /* ---------------------------------------------------------------- */
  /* Lighting: front/rear bars + corner lamps (all flush to the skin) */
  /* ---------------------------------------------------------------- */
  root.add(buildLightBar(2.3, 0.44, 0.56, 0.05, 44, 0.006, headlight));
  root.add(buildLightBar(-2.28, 0.44, 0.56, 0.05, 44, 0.006, taillight));

  // Corner lamps are patches of the body surface, so they can never poke
  // through the skin or float away from it on either side.
  [false, true].forEach(mirror => {
    root.add(buildSurfacePatch(
      {
        uStart: 0.28, uEnd: 0.315,
        xAt: (v, s) => lerp(2.02, 2.26, s),
        rows: 4, cols: 8, offset: 0.007, mirror
      },
      headlight
    ));
    root.add(buildSurfacePatch(
      {
        uStart: 0.28, uEnd: 0.315,
        xAt: (v, s) => lerp(-2.28, -2.05, s),
        rows: 4, cols: 8, offset: 0.007, mirror
      },
      taillight
    ));
  });

  /* ---------------------------------------------------------------- */
  /* Side mirrors (on the beltline, at the A-pillar)                 */
  /* ---------------------------------------------------------------- */
  [1, -1].forEach(side => {
    const base = sectionSurfacePoint(1.0, 0.4, 0.0);

    const stalk = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.045, 0.15), trim);
    stalk.position.set(1.0, base.y, (base.z + 0.05) * side);
    stalk.rotation.y = -side * 0.25;
    root.add(stalk);

    const housing = new THREE.Mesh(roundedBoxGeometry(0.13, 0.085, 0.17, 0.03), shell.clone());
    housing.position.set(0.99, base.y + 0.02, (base.z + 0.17) * side);
    housing.renderOrder = 2;
    root.add(housing);
  });

  /* ---------------------------------------------------------------- */
  /* Technical contour lines: shoulder/beltline + door seams         */
  /* ---------------------------------------------------------------- */
  const beltlineRight = sampleAlong(2.16, -2.16, 0.05, () => 5 / 16, 0.014);
  const beltlineLeft = sampleAlong(2.16, -2.16, 0.05, () => 11 / 16, 0.014);
  const beltline = new THREE.LineSegments(segmentsFromPolylines([beltlineRight, beltlineLeft]), contour);
  beltline.renderOrder = 4;
  root.add(beltline);

  const seams = [];
  [0.94, 0, -0.94].forEach(x => {
    seams.push(sampleUpSection(x, 4 / 16, 5 / 16, 8, 0.014));
    seams.push(sampleUpSection(x, 11 / 16, 12 / 16, 8, 0.014));
  });
  const seamLines = new THREE.LineSegments(segmentsFromPolylines(seams), contour);
  seamLines.renderOrder = 4;
  root.add(seamLines);

  /* ---------------------------------------------------------------- */
  /* Wheels + arches                                                  */
  /* ---------------------------------------------------------------- */
  [
    [DIMS.frontAxle, DIMS.halfTrack],
    [DIMS.frontAxle, -DIMS.halfTrack],
    [DIMS.rearAxle, DIMS.halfTrack],
    [DIMS.rearAxle, -DIMS.halfTrack]
  ].forEach(([x, z]) => root.add(buildWheel(materials, x, z)));

  /* ---------------------------------------------------------------- */
  /* Internal EV systems                                              */
  /* ---------------------------------------------------------------- */
  const componentList = [
    buildBattery(),
    buildMotor(),
    buildBms(),
    buildVcu(),
    buildThermal()
  ];

  const components = {};
  const pickables = [];

  componentList.forEach(component => {
    root.add(component.group);

    if (component.mainMesh) {
      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(component.mainMesh.geometry, 25),
        new THREE.LineBasicMaterial({
          color: component.baseColor.clone(),
          transparent: true,
          opacity: 0
        })
      );
      outline.visible = false;
      outline.userData.isOutline = true;
      outline.renderOrder = 5;
      component.mainMesh.add(outline);
      component.outline = outline;
    }

    component.meshes.forEach(mesh => {
      pickables.push(mesh);
      if (!component.pickables) component.pickables = [];
      component.pickables.push(mesh);
    });

    components[component.id] = component;
  });

  /* ---------------------------------------------------------------- */
  /* Visual modes                                                     */
  /* ---------------------------------------------------------------- */
  const NORMAL = { shell: 0.6, glass: 0.62, contour: 0.42 };
  const CUTAWAY = { shell: 0.16, glass: 0.3, contour: 0.55 };
  let cutaway = false;

  function applyShellOpacity() {
    const mode = cutaway ? CUTAWAY : NORMAL;
    shell.opacity = mode.shell;
    glass.opacity = mode.glass;
    contour.opacity = mode.contour;
    shell.needsUpdate = true;
    glass.needsUpdate = true;
    contour.needsUpdate = true;
  }

  function setCutaway(enabled) {
    cutaway = !!enabled;
    applyShellOpacity();
  }

  /* ---------------------------------------------------------------- */
  /* API consumed by the viewer                                       */
  /* ---------------------------------------------------------------- */
  function dispose() {
    root.traverse(object => {
      if (object.geometry) object.geometry.dispose();

      if (object.material) {
        const list = Array.isArray(object.material) ? object.material : [object.material];
        list.forEach(material => material.dispose());
      }
    });
  }

  return {
    root,
    components,
    pickables,
    materials,
    setCutaway,
    dispose,
    dimensions: DIMS
  };
}

export default buildEVCar;
