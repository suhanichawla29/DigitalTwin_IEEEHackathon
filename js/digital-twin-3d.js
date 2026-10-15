/*
 * digital-twin-3d.js
 * ---------------------------------------------------------------------------
 * Three.js renderer / scene orchestration for the Digital Twin viewer.
 *
 * Responsibilities:
 *   - renderer, scene, camera, lighting, environment, platform
 *   - the procedural EV (delegated to ev-car-model.js)
 *   - OrbitControls (drag / wheel / touch / pinch)
 *   - automatic 360° rotation of the car
 *   - cutaway mode
 *   - raycast component selection + status colouring
 *   - responsive resize, reduced-motion handling, full teardown
 *
 * Deliberately free of dashboard/business logic. The controller in
 * digital-twin.js owns shared UI state and calls into this module.
 */

import * as THREE from 'three';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { RoomEnvironment } from './vendor/three/RoomEnvironment.js';
import { buildEVCar } from './ev-car-model.js';

const STATUS_COLORS = {
  normal: null,          // use component's own accent colour
  warning: 0xffbd5b,
  critical: 0xff5b6e,
  offline: 0x5d6f83
};

const DEFAULT_CAMERA = new THREE.Vector3(4.7, 2.45, 4.5);
const DEFAULT_TARGET = new THREE.Vector3(0, 0.72, 0);
const ROTATION_SPEED = 0.28; // radians / second  (~22 s per revolution)

function disposeScene(scene) {
  scene.traverse(object => {
    if (object.geometry) object.geometry.dispose();

    if (object.material) {
      const list = Array.isArray(object.material)
        ? object.material
        : [object.material];

      list.forEach(material => {
        if (material.map) material.map.dispose();
        material.dispose();
      });
    }
  });
}

/** Small canvas radial-gradient texture used as a soft ground light pool. */
function makeGlowTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(
    size / 2, size / 2, 0,
    size / 2, size / 2, size / 2
  );

  gradient.addColorStop(0, 'rgba(40, 190, 255, 0.55)');
  gradient.addColorStop(0.45, 'rgba(30, 120, 220, 0.16)');
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createViewer(container, options = {}) {
  const onSelect = options.onSelect || (() => {});
  const prefersReducedMotion = !!options.reducedMotion;

  /* ---------------------------------------------------------------- */
  /* Renderer                                                         */
  /* ---------------------------------------------------------------- */
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance'
  });

  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.classList.add('twin-canvas');
  renderer.domElement.setAttribute('aria-hidden', 'true');
  container.appendChild(renderer.domElement);

  /* ---------------------------------------------------------------- */
  /* Scene + camera                                                   */
  /* ---------------------------------------------------------------- */
  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 120);
  camera.position.copy(DEFAULT_CAMERA);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.enablePan = false;
  controls.rotateSpeed = 0.9;
  controls.zoomSpeed = 0.9;
  controls.minDistance = 3.4;
  controls.maxDistance = 11;
  controls.minPolarAngle = 0.16;
  controls.maxPolarAngle = 1.52;
  controls.target.copy(DEFAULT_TARGET);
  controls.update();

  /* ---------------------------------------------------------------- */
  /* Lighting                                                         */
  /* ---------------------------------------------------------------- */
  scene.add(new THREE.HemisphereLight(0x9ec9ff, 0x040a12, 0.95));
  scene.add(new THREE.AmbientLight(0x22406a, 0.35));

  const keyLight = new THREE.DirectionalLight(0xffffff, 2.1);
  keyLight.position.set(5, 8, 5);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.camera.near = 0.5;
  keyLight.shadow.camera.far = 26;
  keyLight.shadow.camera.left = -3.4;
  keyLight.shadow.camera.right = 3.4;
  keyLight.shadow.camera.top = 3.4;
  keyLight.shadow.camera.bottom = -3.4;
  keyLight.shadow.bias = -0.0006;
  keyLight.shadow.normalBias = 0.02;
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0x2ab6ff, 0.85);
  fillLight.position.set(-6, 3, -2.5);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0xb07dff, 0.75);
  rimLight.position.set(-3, 2.5, 6);
  scene.add(rimLight);

  const underGlow = new THREE.PointLight(0x00e6c3, 1.5, 7, 2);
  underGlow.position.set(0, 0.3, 0);
  scene.add(underGlow);

  /* ---------------------------------------------------------------- */
  /* Environment (metal + glass reflections)                          */
  /* ---------------------------------------------------------------- */
  const pmrem = new THREE.PMREMGenerator(renderer);
  const roomEnv = new RoomEnvironment();
  const envRenderTarget = pmrem.fromScene(roomEnv, 0.04);
  scene.environment = envRenderTarget.texture;
  disposeScene(roomEnv);
  pmrem.dispose();

  /* ---------------------------------------------------------------- */
  /* Ground platform                                                  */
  /* ---------------------------------------------------------------- */
  const platform = new THREE.Mesh(
    new THREE.CircleGeometry(3.0, 72),
    new THREE.MeshStandardMaterial({
      color: 0x05111f,
      metalness: 0.35,
      roughness: 0.72
    })
  );
  platform.rotation.x = -Math.PI / 2;
  platform.receiveShadow = true;
  scene.add(platform);

  const grid = new THREE.PolarGridHelper(2.9, 8, 5, 64, 0x1a4a6b, 0x0e2a42);
  grid.position.y = 0.003;
  grid.material.transparent = true;
  grid.material.opacity = 0.32;
  scene.add(grid);

  const glowTexture = makeGlowTexture();
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(6.2, 6.2),
    new THREE.MeshBasicMaterial({
      map: glowTexture,
      transparent: true,
      opacity: 0.15,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    })
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.006;
  scene.add(glow);

  /* ---------------------------------------------------------------- */
  /* Vehicle                                                          */
  /* ---------------------------------------------------------------- */
  const car = buildEVCar();
  const carRoot = car.root;
  scene.add(carRoot);

  const pickables = car.pickables;
  const components = car.components;

  const statuses = {};
  Object.keys(components).forEach(id => {
    statuses[id] = 'normal';
  });

  let selectedId = null;
  let autoRotate = !prefersReducedMotion;
  let cutaway = false;

  function applyAppearance(id) {
    const component = components[id];
    if (!component) return;

    const status = statuses[id] || 'normal';
    const selected = selectedId === id;

    let color = component.baseColor.getHex();
    let intensity = 0.4;

    if (status === 'critical') {
      color = STATUS_COLORS.critical;
      intensity = 1.15;
    } else if (status === 'warning') {
      color = STATUS_COLORS.warning;
      intensity = 0.95;
    } else if (status === 'offline') {
      color = STATUS_COLORS.offline;
      intensity = 0.12;
    }

    if (selected) intensity *= 1.9;

    component.surface.emissive.setHex(color);
    component.surface.emissiveIntensity = intensity;

    component.accent.emissive.setHex(color);
    component.accent.emissiveIntensity = Math.min(intensity * 1.7, 2.4);

    if (component.outline) {
      component.outline.visible = selected;
      component.outline.material.color.setHex(selected ? 0xffffff : color);
      component.outline.material.opacity = selected ? 0.9 : 0;
    }
  }

  Object.keys(components).forEach(applyAppearance);

  /* ---------------------------------------------------------------- */
  /* Pointer interaction (selection / hover)                          */
  /* ---------------------------------------------------------------- */
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const domElement = renderer.domElement;

  let pointerDown = null;
  let hoveredId = null;

  function pickAt(clientX, clientY) {
    const rect = domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(pointer, camera);

    const hits = raycaster.intersectObjects(pickables, false);
    if (!hits.length) return null;

    return hits[0].object.userData.componentId || null;
  }

  function handlePointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    pointerDown = { x: event.clientX, y: event.clientY, time: performance.now() };
  }

  function handlePointerUp(event) {
    if (!pointerDown) return;

    const moved = Math.hypot(
      event.clientX - pointerDown.x,
      event.clientY - pointerDown.y
    );
    const elapsed = performance.now() - pointerDown.time;
    pointerDown = null;

    if (moved > 6 || elapsed > 500) return;

    const id = pickAt(event.clientX, event.clientY);
    if (id) onSelect(id);
  }

  function handlePointerMove(event) {
    const id = pickAt(event.clientX, event.clientY);

    if (id !== hoveredId) {
      hoveredId = id;
      domElement.style.cursor = id ? 'pointer' : 'grab';
    }
  }

  domElement.addEventListener('pointerdown', handlePointerDown);
  domElement.addEventListener('pointerup', handlePointerUp);
  domElement.addEventListener('pointermove', handlePointerMove);

  /* ---------------------------------------------------------------- */
  /* Resize                                                           */
  /* ---------------------------------------------------------------- */
  function resize() {
    const width = container.clientWidth;
    const height = container.clientHeight;

    if (width === 0 || height === 0) return;

    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  resize();

  /* ---------------------------------------------------------------- */
  /* Reset-view tween                                                 */
  /* ---------------------------------------------------------------- */
  let resetState = null;

  function easeInOut(t) {
    return t < 0.5
      ? 4 * t * t * t
      : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function resetView() {
    let yaw = carRoot.rotation.y % (Math.PI * 2);
    if (yaw > Math.PI) yaw -= Math.PI * 2;
    if (yaw < -Math.PI) yaw += Math.PI * 2;

    resetState = {
      t: 0,
      fromPosition: camera.position.clone(),
      fromTarget: controls.target.clone(),
      yaw
    };

    controls.enabled = false;
  }

  /* ---------------------------------------------------------------- */
  /* Animation loop                                                   */
  /* ---------------------------------------------------------------- */
  const clock = new THREE.Clock();
  let frameId = null;
  let disposed = false;

  function animate() {
    if (disposed) return;
    frameId = requestAnimationFrame(animate);

    const delta = Math.min(clock.getDelta(), 0.05);

    // Skip rendering (and rotation) while the viewer is not laid out — e.g. when
    // another dashboard route is active — to avoid off-screen GPU work.
    if (container.clientWidth === 0 || container.clientHeight === 0) {
      return;
    }

    // Automatic 360° rotation about the vehicle's vertical axis.
    if (autoRotate) {
      carRoot.rotation.y += ROTATION_SPEED * delta;
    }

    if (resetState) {
      resetState.t = Math.min(1, resetState.t + delta / 0.6);
      const k = easeInOut(resetState.t);

      camera.position.lerpVectors(
        resetState.fromPosition,
        DEFAULT_CAMERA,
        k
      );
      controls.target.lerpVectors(
        resetState.fromTarget,
        DEFAULT_TARGET,
        k
      );
      carRoot.rotation.y = resetState.yaw * (1 - k);

      if (resetState.t >= 1) {
        resetState = null;
        controls.enabled = true;
      }
    }

    controls.update();
    renderer.render(scene, camera);
  }

  animate();

  /* ---------------------------------------------------------------- */
  /* Public API                                                       */
  /* ---------------------------------------------------------------- */
  return {
    setAutoRotate(enabled) {
      autoRotate = !!enabled;
    },

    isAutoRotating() {
      return autoRotate;
    },

    setCutaway(enabled) {
      cutaway = !!enabled;
      car.setCutaway(cutaway);
    },

    isCutaway() {
      return cutaway;
    },

    setStatus(id, status) {
      if (!components[id]) return;
      statuses[id] = status;
      applyAppearance(id);
    },

    select(id) {
      selectedId = components[id] ? id : null;
      Object.keys(components).forEach(applyAppearance);
    },

    getSelected() {
      return selectedId;
    },

    resetView,

    /** Current vehicle yaw in degrees (0-359), for the live readout. */
    getRotationDegrees() {
      const deg = (carRoot.rotation.y * 180) / Math.PI;
      return ((deg % 360) + 360) % 360;
    },

    dispose() {
      disposed = true;

      if (frameId) cancelAnimationFrame(frameId);

      resizeObserver.disconnect();
      domElement.removeEventListener('pointerdown', handlePointerDown);
      domElement.removeEventListener('pointerup', handlePointerUp);
      domElement.removeEventListener('pointermove', handlePointerMove);

      controls.dispose();

      car.dispose();
      disposeScene(scene);

      if (envRenderTarget) envRenderTarget.dispose();
      if (glowTexture) glowTexture.dispose();

      renderer.dispose();
      renderer.forceContextLoss();

      if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
    }
  };
}

export default createViewer;
