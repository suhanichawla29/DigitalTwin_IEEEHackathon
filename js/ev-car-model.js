/*
 * ev-car-model.js
 * ---------------------------------------------------------------------------
 * Procedural stylized electric-vehicle model built entirely from Three.js
 * geometry and materials. No external GLB/GLTF asset is required at runtime.
 *
 * This is a *conceptual* digital twin visualisation, not an engineering CAD
 * model. Component placement is illustrative.
 *
 * Exposes a single factory: buildEVCar()
 *   -> { root, components, pickables, materials, dispose }
 *
 * The module is intentionally free of any dashboard/business logic so that the
 * 3D geometry can be reused or unit-replaced independently of the UI.
 */

import * as THREE from 'three';

/* --------------------------------------------------------------------------
 * Shared tuning values (metres; car faces +X)
 * ------------------------------------------------------------------------ */
const DIMS = Object.freeze({
  length: 4.6,
  bodyDepth: 1.6,
  bevel: 0.07,
  wheelRadius: 0.34,
  wheelWidth: 0.26,
  frontAxle: 1.42,
  rearAxle: -1.42,
  track: 0.9
});

/* Component palette — restrained neon accents on a dark body. */
export const COMPONENT_COLORS = Object.freeze({
  battery: 0x1ce0c0,
  motor: 0x22d3ff,
  thermal: 0xa278ff,
  bms: 0xe8b45a,
  vcu: 0x4f9dff
});

export const COMPONENT_LABELS = Object.freeze({
  battery: 'Battery Pack',
  motor: 'Motor Controller',
  thermal: 'Thermal System',
  bms: 'BMS',
  vcu: 'VCU'
});

/* --------------------------------------------------------------------------
 * Shape helpers
 * ------------------------------------------------------------------------ */

/** Extrude a side-profile shape across the car's width (Z axis) and centre it. */
function extrudeProfile(shape, depth, bevel, curveSegments = 16) {
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: 0,
    bevelSegments: 4,
    curveSegments
  });

  // Extrusion runs along +Z starting at 0; centre it on the origin.
  geometry.translate(0, 0, -depth / 2);
  geometry.computeVertexNormals();

  return geometry;
}

/** Build a thin body-coloured strut (used for roof pillars). */
function strut(material, x1, y1, x2, y2, z, thickness = 0.075) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  const angle = Math.atan2(dy, dx) - Math.PI / 2;

  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(thickness, length, thickness),
    material
  );

  mesh.position.set((x1 + x2) / 2, (y1 + y2) / 2, z);
  mesh.rotation.z = angle;

  return mesh;
}

function roundedBoxGeometry(width, height, depth, radius = 0.06, segments = 4) {
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
    depth: depth - radius,
    bevelEnabled: true,
    bevelThickness: radius / 2,
    bevelSize: radius / 2,
    bevelSegments: Math.max(2, segments),
    curveSegments: Math.max(2, segments)
  });

  geometry.translate(0, 0, -(depth - radius) / 2);
  geometry.computeVertexNormals();

  return geometry;
}

/* --------------------------------------------------------------------------
 * Wheels
 * ------------------------------------------------------------------------ */
function buildWheel(materials, x, z) {
  const { wheelRadius: R, wheelWidth: W } = DIMS;
  const group = new THREE.Group();

  const tire = new THREE.Mesh(
    new THREE.CylinderGeometry(R, R, W, 36, 1, false),
    materials.tire
  );
  tire.rotation.x = Math.PI / 2;
  tire.castShadow = true;
  group.add(tire);

  // Slightly inset sidewall so the rim sits within the tire.
  const rim = new THREE.Mesh(
    new THREE.CylinderGeometry(R * 0.68, R * 0.68, W * 1.02, 28),
    materials.rim
  );
  rim.rotation.x = Math.PI / 2;
  group.add(rim);

  // Dark brake disc behind the spokes.
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(R * 0.55, R * 0.55, W * 0.5, 22),
    materials.trim
  );
  disc.rotation.x = Math.PI / 2;
  group.add(disc);

  // Five spokes per wheel, on the outer face.
  const outer = z > 0 ? 1 : -1;
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2;
    const spoke = new THREE.Mesh(
      new THREE.BoxGeometry(R * 0.86, 0.05, 0.035),
      materials.rim
    );

    spoke.position.set(
      Math.cos(angle) * R * 0.36,
      Math.sin(angle) * R * 0.36,
      outer * W * 0.52
    );
    spoke.rotation.z = angle;
    group.add(spoke);
  }

  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(R * 0.17, R * 0.17, W * 1.12, 20),
    materials.hub
  );
  hub.rotation.x = Math.PI / 2;
  group.add(hub);

  group.position.set(x, R, z);

  return group;
}

/* --------------------------------------------------------------------------
 * Internal EV components
 * ------------------------------------------------------------------------ */

/**
 * Register a component group. Every mesh receives `userData.componentId`
 * so the raycaster can resolve a hit back to its logical component.
 */
function makeComponent(id, label, baseColor, materials) {
  const group = new THREE.Group();
  group.name = 'component-' + id;
  group.userData.componentId = id;

  const surface = new THREE.MeshStandardMaterial({
    color: 0x0a1626,
    metalness: 0.45,
    roughness: 0.42,
    emissive: new THREE.Color(baseColor),
    emissiveIntensity: 0.35
  });

  const accent = new THREE.MeshStandardMaterial({
    color: 0x050b14,
    metalness: 0.3,
    roughness: 0.5,
    emissive: new THREE.Color(baseColor),
    emissiveIntensity: 0.85
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
    outline: null,
    materials
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

function buildBattery(materials) {
  const battery = makeComponent(
    'battery',
    COMPONENT_LABELS.battery,
    COMPONENT_COLORS.battery,
    materials
  );

  // Main pack running along the vehicle floor.
  addMesh(
    battery,
    roundedBoxGeometry(2.95, 0.26, 1.5, 0.05),
    battery.surface,
    [-0.05, 0.47, 0]
  );

  // Module / cell rows, slightly emissive to read through a cutaway body.
  for (let i = 0; i < 11; i++) {
    addMesh(
      battery,
      new THREE.BoxGeometry(0.06, 0.2, 1.34),
      battery.accent,
      [-1.4 + i * 0.27, 0.47, 0]
    );
  }

  // High-voltage bus bars along the pack edge.
  addMesh(
    battery,
    new THREE.BoxGeometry(2.8, 0.03, 0.05),
    battery.accent,
    [-0.05, 0.6, 0.62]
  );
  addMesh(
    battery,
    new THREE.BoxGeometry(2.8, 0.03, 0.05),
    battery.accent,
    [-0.05, 0.6, -0.62]
  );

  return battery;
}

function buildMotor(materials) {
  const motor = makeComponent(
    'motor',
    COMPONENT_LABELS.motor,
    COMPONENT_COLORS.motor,
    materials
  );

  // Traction motor near the rear axle (axis along the vehicle's X axis).
  addMesh(
    motor,
    new THREE.CylinderGeometry(0.23, 0.23, 0.42, 28),
    motor.surface,
    [-1.42, 0.52, 0],
    [0, 0, Math.PI / 2]
  );

  // Cooling fins.
  for (let i = 0; i < 6; i++) {
    addMesh(
      motor,
      new THREE.CylinderGeometry(0.25, 0.25, 0.02, 24),
      motor.accent,
      [-1.6 + i * 0.075, 0.52, 0],
      [0, 0, Math.PI / 2]
    );
  }

  // Motor controller / inverter on top.
  addMesh(
    motor,
    roundedBoxGeometry(0.5, 0.24, 0.52, 0.05),
    motor.surface,
    [-1.28, 0.72, 0]
  );

  addMesh(
    motor,
    new THREE.BoxGeometry(0.4, 0.02, 0.4),
    motor.accent,
    [-1.28, 0.85, 0]
  );

  return motor;
}

function buildBms(materials) {
  const bms = makeComponent(
    'bms',
    COMPONENT_LABELS.bms,
    COMPONENT_COLORS.bms,
    materials
  );

  addMesh(
    bms,
    roundedBoxGeometry(0.56, 0.16, 0.5, 0.05),
    bms.surface,
    [0.7, 0.66, 0.34]
  );

  // Harness connectors.
  for (let i = 0; i < 4; i++) {
    addMesh(
      bms,
      new THREE.BoxGeometry(0.05, 0.05, 0.16),
      bms.accent,
      [0.55 + i * 0.12, 0.74, 0.34]
    );
  }

  return bms;
}

function buildVcu(materials) {
  const vcu = makeComponent(
    'vcu',
    COMPONENT_LABELS.vcu,
    COMPONENT_COLORS.vcu,
    materials
  );

  addMesh(
    vcu,
    roundedBoxGeometry(0.5, 0.16, 0.42, 0.05),
    vcu.surface,
    [0.98, 0.78, -0.3]
  );

  addMesh(
    vcu,
    new THREE.BoxGeometry(0.34, 0.02, 0.28),
    vcu.accent,
    [0.98, 0.87, -0.3]
  );

  return vcu;
}

function buildThermal(materials) {
  const thermal = makeComponent(
    'thermal',
    COMPONENT_LABELS.thermal,
    COMPONENT_COLORS.thermal,
    materials
  );

  // Coolant loop running around the battery pack perimeter.
  const loop = new THREE.CatmullRomCurve3(
    [
      new THREE.Vector3(1.55, 0.56, 0.72),
      new THREE.Vector3(0, 0.56, 0.78),
      new THREE.Vector3(-1.55, 0.56, 0.72),
      new THREE.Vector3(-1.62, 0.56, 0),
      new THREE.Vector3(-1.55, 0.56, -0.72),
      new THREE.Vector3(0, 0.56, -0.78),
      new THREE.Vector3(1.55, 0.56, -0.72),
      new THREE.Vector3(1.64, 0.56, 0)
    ],
    true,
    'catmullrom',
    0.4
  );

  addMesh(
    thermal,
    new THREE.TubeGeometry(loop, 90, 0.032, 8, true),
    thermal.accent
  );

  // Small pump on the loop.
  addMesh(
    thermal,
    new THREE.CylinderGeometry(0.09, 0.09, 0.12, 18),
    thermal.surface,
    [1.55, 0.58, 0.72],
    [Math.PI / 2, 0, 0]
  );

  // Front radiator.
  addMesh(
    thermal,
    roundedBoxGeometry(0.1, 0.34, 0.9, 0.03),
    thermal.surface,
    [2.06, 0.5, 0]
  );

  for (let i = 0; i < 7; i++) {
    addMesh(
      thermal,
      new THREE.BoxGeometry(0.02, 0.28, 0.02),
      thermal.accent,
      [2.02, 0.5, -0.36 + i * 0.12]
    );
  }

  return thermal;
}

/* --------------------------------------------------------------------------
 * Main factory
 * ------------------------------------------------------------------------ */
export function buildEVCar() {
  const root = new THREE.Group();
  root.name = 'EvCar';

  /* ------------------------------------------------------------------
   * Materials
   * ---------------------------------------------------------------- */
  const paint = new THREE.MeshPhysicalMaterial({
    color: 0x123f6d,
    metalness: 0.85,
    roughness: 0.26,
    clearcoat: 1,
    clearcoatRoughness: 0.12,
    emissive: new THREE.Color(0x03101f),
    emissiveIntensity: 0.55,
    envMapIntensity: 0.95
  });

  const paintDark = new THREE.MeshPhysicalMaterial({
    color: 0x0a2540,
    metalness: 0.8,
    roughness: 0.34,
    clearcoat: 0.6,
    emissive: new THREE.Color(0x02080f),
    emissiveIntensity: 0.4,
    envMapIntensity: 0.8
  });

  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x123a55,
    metalness: 0.25,
    roughness: 0.06,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    transparent: true,
    opacity: 0.5,
    envMapIntensity: 1.5,
    side: THREE.DoubleSide
  });

  const trim = new THREE.MeshStandardMaterial({
    color: 0x0a1019,
    metalness: 0.35,
    roughness: 0.62,
    envMapIntensity: 0.6
  });

  const tire = new THREE.MeshStandardMaterial({
    color: 0x0a0d12,
    metalness: 0.05,
    roughness: 0.94,
    envMapIntensity: 0.35
  });

  const rim = new THREE.MeshStandardMaterial({
    color: 0xa9bacb,
    metalness: 1,
    roughness: 0.28,
    envMapIntensity: 1.1
  });

  const hub = new THREE.MeshStandardMaterial({
    color: 0x0b1826,
    metalness: 0.7,
    roughness: 0.4,
    emissive: new THREE.Color(0x0a6f8f),
    emissiveIntensity: 0.5
  });

  const headlight = new THREE.MeshStandardMaterial({
    color: 0xdff6ff,
    metalness: 0.2,
    roughness: 0.15,
    emissive: new THREE.Color(0x9fe9ff),
    emissiveIntensity: 1.6
  });

  const taillight = new THREE.MeshStandardMaterial({
    color: 0xff6b8a,
    metalness: 0.2,
    roughness: 0.2,
    emissive: new THREE.Color(0xff2f5c),
    emissiveIntensity: 1.5
  });

  const materials = {
    paint,
    paintDark,
    glass,
    trim,
    tire,
    rim,
    hub,
    headlight,
    taillight
  };

  /* ------------------------------------------------------------------
   * Lower body (side-profile extrusion)
   * ---------------------------------------------------------------- */
  const bodyShape = new THREE.Shape();
  bodyShape.moveTo(-2.18, 0.33);
  bodyShape.lineTo(1.82, 0.33);
  bodyShape.quadraticCurveTo(2.06, 0.33, 2.22, 0.42);
  bodyShape.lineTo(2.34, 0.52);
  bodyShape.quadraticCurveTo(2.38, 0.63, 2.26, 0.72);
  bodyShape.quadraticCurveTo(2.12, 0.84, 1.82, 0.92);
  bodyShape.quadraticCurveTo(1.56, 1.0, 0.96, 1.03);
  bodyShape.quadraticCurveTo(0.05, 1.06, -1.28, 1.03);
  bodyShape.lineTo(-2.04, 1.0);
  bodyShape.quadraticCurveTo(-2.3, 0.97, -2.34, 0.8);
  bodyShape.lineTo(-2.34, 0.55);
  bodyShape.quadraticCurveTo(-2.34, 0.4, -2.18, 0.33);

  const bodyMesh = new THREE.Mesh(
    extrudeProfile(bodyShape, DIMS.bodyDepth, DIMS.bevel, 18),
    paint
  );
  bodyMesh.name = 'body';
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  root.add(bodyMesh);

  // Rocker / sill panels for a slimmer waist.
  [-1, 1].forEach(side => {
    const sill = new THREE.Mesh(
      new THREE.BoxGeometry(3.1, 0.13, 0.09),
      paintDark
    );
    sill.position.set(-0.1, 0.36, side * 0.845);
    sill.castShadow = true;
    root.add(sill);
  });

  /* ------------------------------------------------------------------
   * Greenhouse (glass cabin) + pillars + roof
   * ---------------------------------------------------------------- */
  const cabinShape = new THREE.Shape();
  cabinShape.moveTo(-1.94, 0.98);
  cabinShape.quadraticCurveTo(-1.84, 1.14, -1.52, 1.32);
  cabinShape.quadraticCurveTo(-1.26, 1.43, -0.9, 1.45);
  cabinShape.lineTo(0.28, 1.47);
  cabinShape.quadraticCurveTo(0.62, 1.46, 0.9, 1.33);
  cabinShape.quadraticCurveTo(1.2, 1.16, 1.5, 0.99);
  cabinShape.lineTo(-1.94, 0.98);

  const cabin = new THREE.Mesh(
    extrudeProfile(cabinShape, 1.42, 0.04, 16),
    glass
  );
  cabin.name = 'cabin';
  root.add(cabin);

  const roof = new THREE.Mesh(
    roundedBoxGeometry(1.6, 0.08, 1.42, 0.05),
    paint
  );
  roof.position.set(-0.32, 1.45, 0);
  roof.castShadow = true;
  root.add(roof);

  // Pillars (both sides).
  [-1, 1].forEach(side => {
    const z = side * 0.685;
    root.add(strut(paintDark, 1.46, 1.0, 0.86, 1.45, z));      // A-pillar
    root.add(strut(paintDark, 0.0, 1.0, 0.0, 1.46, z, 0.06));  // B-pillar
    root.add(strut(paintDark, -1.3, 1.45, -1.9, 1.0, z));      // C-pillar
  });

  /* ------------------------------------------------------------------
   * Fascia details: lights, bumpers, grille, mirrors
   * ---------------------------------------------------------------- */
  // Headlights + daytime running strip.
  [-1, 1].forEach(side => {
    const lamp = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.11, 0.46),
      headlight
    );
    lamp.position.set(2.2, 0.74, side * 0.5);
    lamp.rotation.y = side * 0.12;
    root.add(lamp);
  });

  const drl = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.03, 1.3),
    headlight
  );
  drl.position.set(2.26, 0.6, 0);
  root.add(drl);

  // Tail light bar.
  const tail = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.09, 1.5),
    taillight
  );
  tail.position.set(-2.32, 0.86, 0);
  root.add(tail);

  [-1, 1].forEach(side => {
    const corner = new THREE.Mesh(
      new THREE.BoxGeometry(0.07, 0.16, 0.22),
      taillight
    );
    corner.position.set(-2.29, 0.86, side * 0.66);
    root.add(corner);
  });

  // Bumpers / lower fascia.
  const frontBumper = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 0.26, 1.5),
    trim
  );
  frontBumper.position.set(2.24, 0.4, 0);
  root.add(frontBumper);

  const rearBumper = new THREE.Mesh(
    new THREE.BoxGeometry(0.16, 0.26, 1.5),
    trim
  );
  rearBumper.position.set(-2.26, 0.4, 0);
  root.add(rearBumper);

  const grille = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, 0.16, 1.1),
    paintDark
  );
  grille.position.set(2.32, 0.56, 0);
  root.add(grille);

  // Side mirrors.
  [-1, 1].forEach(side => {
    const mirror = new THREE.Mesh(
      roundedBoxGeometry(0.16, 0.1, 0.2, 0.03),
      paintDark
    );
    mirror.position.set(1.18, 1.06, side * 1.02);
    root.add(mirror);

    const stalk = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.03, 0.12),
      trim
    );
    stalk.position.set(1.14, 1.02, side * 0.9);
    root.add(stalk);
  });

  /* ------------------------------------------------------------------
   * Wheels + arches
   * ---------------------------------------------------------------- */
  const wheelPositions = [
    [DIMS.frontAxle, DIMS.track],
    [DIMS.frontAxle, -DIMS.track],
    [DIMS.rearAxle, DIMS.track],
    [DIMS.rearAxle, -DIMS.track]
  ];

  wheelPositions.forEach(([x, z]) => {
    const wheel = buildWheel(materials, x, z);
    root.add(wheel);

    const arch = new THREE.Mesh(
      new THREE.TorusGeometry(
        DIMS.wheelRadius + 0.07,
        0.055,
        8,
        26,
        Math.PI
      ),
      paintDark
    );
    arch.position.set(x, DIMS.wheelRadius + 0.02, z * 1.02);
    root.add(arch);
  });

  // Flat underbody tray.
  const underbody = new THREE.Mesh(
    new THREE.BoxGeometry(3.7, 0.05, 1.5),
    trim
  );
  underbody.position.set(-0.05, 0.3, 0);
  root.add(underbody);

  /* ------------------------------------------------------------------
   * Internal EV components
   * ---------------------------------------------------------------- */
  const componentList = [
    buildBattery(materials),
    buildMotor(materials),
    buildBms(materials),
    buildVcu(materials),
    buildThermal(materials)
  ];

  const components = {};
  const pickables = [];

  componentList.forEach(component => {
    root.add(component.group);

    // Clean edge outline used for selection feedback.
    if (component.mainMesh) {
      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(component.mainMesh.geometry, 25),
        new THREE.LineBasicMaterial({
          color: component.baseColor.clone(),
          transparent: true,
          opacity: 0.0
        })
      );
      outline.visible = false;
      outline.userData.isOutline = true;
      component.mainMesh.add(outline);
      component.outline = outline;
    }

    component.group.visible = true;

    component.meshes.forEach(mesh => {
      // Internal components must never be culled by the body shell.
      mesh.material.depthTest = true;
      pickables.push(mesh);
    });

    component.meshes.forEach(mesh => {
      if (!component.pickables) component.pickables = [];
      component.pickables.push(mesh);
    });

    components[component.id] = component;
  });

  /* ------------------------------------------------------------------
   * API consumed by the viewer
   * ---------------------------------------------------------------- */
  function setCutaway(enabled) {
    paint.transparent = enabled;
    paint.opacity = enabled ? 0.22 : 1;
    paint.depthWrite = !enabled;
    paint.needsUpdate = true;

    paintDark.transparent = enabled;
    paintDark.opacity = enabled ? 0.22 : 1;
    paintDark.depthWrite = !enabled;
    paintDark.needsUpdate = true;

    glass.opacity = enabled ? 0.14 : 0.5;
    glass.needsUpdate = true;

    roof.visible = !enabled;
  }

  function dispose() {
    root.traverse(object => {
      if (object.geometry) {
        object.geometry.dispose();
      }

      if (object.material) {
        const list = Array.isArray(object.material)
          ? object.material
          : [object.material];

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
