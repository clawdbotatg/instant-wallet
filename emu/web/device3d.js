// The wallet in 3D: the real case STLs from hardware/case/zez0000 (black base, white lid, grey joystick
// cap, green A, grey B and X, red Y), the LCD glass with the live framebuffer as a texture.
// Orbit to look around, click the caps to press them.
//
// Frames. Lid STL: printed face down, outer face at z=0, buttons at x -21.67, joystick at
// x +19.48, window 23.2 mm square at (-0.4, -0.1). Base STL: floor at z=0, USB slot on the +x end.
// World: x along the case (+ toward the joystick and USB), y across, z up. Lid flipped onto the
// base: world = (lx, -ly, 26.1 - lz). three.js: (-wx, wz, wy), so the joystick is on the left and
// the screen's top edge points away from the viewer.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const LID_TOP = 26.1;            // base 10.5 + lid 15.6
const CAP_X = 21.67;             // three.x of the button column
const CAP_Z = { A: -8.63, B: -2.88, X: 2.87, Y: 8.62 };
const CAP_REST = 23.3, CAP_PRESS = 0.9;
const JOY = { x: -19.48, y: LID_TOP + 1.2, z: 0.32 };
const JOY_TILT = 0.24, JOY_PRESS = 0.6;
const COLORS = { lid: 0xf1efe8, base: 0x141416, joy: 0x55555a, A: 0x27b04b, B: 0x77777b, X: 0x77777b, Y: 0xd7263d };

export async function createDevice3D(container, screenCanvas, { onKey, onGrab }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;

  const camera = new THREE.PerspectiveCamera(30, 1, 1, 2000);
  camera.position.set(8, 92, 108);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 14, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 40;
  controls.maxDistance = 400;
  controls.maxPolarAngle = Math.PI * 0.49;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x1a1a22, 0.5));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(40, 90, 50);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -70, right: 70, top: 70, bottom: -70, near: 10, far: 250 });
  sun.shadow.bias = -0.0005;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xbfd0ff, 0.5);
  fill.position.set(-60, 40, -40);
  scene.add(fill);
  const led = new THREE.PointLight(0x50ff70, 0, 40, 1.5);
  led.position.set(-22, 4, 0);
  scene.add(led);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ color: 0x0f1014, roughness: 0.95, metalness: 0 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const device = new THREE.Group();
  scene.add(device);

  // --- STL parts --------------------------------------------------------------------------
  const loader = new STLLoader();
  const M_BASE = new THREE.Matrix4().set(-1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1);
  const M_LID = new THREE.Matrix4().set(-1, 0, 0, 0, 0, 0, -1, LID_TOP, 0, -1, 0, 0, 0, 0, 0, 1);
  const [gBase, gLid, gCap, gJoy] = await Promise.all(["base_v5", "lid_v4", "button_cap_1", "joystick_cap_v3_2.00"].map((n) => loader.loadAsync(`/stl/${n}.stl`)));

  const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.0, ...extra });
  const mkMesh = (geo, material) => { const m = new THREE.Mesh(geo, material); m.castShadow = true; m.receiveShadow = true; device.add(m); return m; };

  gBase.applyMatrix4(M_BASE); gBase.computeVertexNormals();
  mkMesh(gBase, mat(COLORS.base, { roughness: 0.5 }));
  gLid.applyMatrix4(M_LID); gLid.computeVertexNormals();
  mkMesh(gLid, mat(COLORS.lid, { roughness: 0.7 }));

  gCap.computeBoundingBox();
  const c = gCap.boundingBox.getCenter(new THREE.Vector3());
  gCap.translate(-c.x, -c.y, 0);
  gCap.applyMatrix4(M_BASE); gCap.computeVertexNormals();
  const caps = {};
  for (const k of ["A", "B", "X", "Y"]) {
    const m = mkMesh(gCap, mat(COLORS[k], { roughness: 0.55 }));
    m.position.set(CAP_X, CAP_REST, CAP_Z[k]);
    m.userData.key = k;
    caps[k] = m;
  }
  gJoy.applyMatrix4(M_BASE); gJoy.computeVertexNormals();
  const joy = mkMesh(gJoy, mat(COLORS.joy, { roughness: 0.6 }));
  joy.position.set(JOY.x, JOY.y, JOY.z);
  joy.userData.key = "joy";
  const stem = new THREE.Mesh(new THREE.BoxGeometry(1.9, 3, 1.9), mat(0x222226));
  stem.position.set(JOY.x, LID_TOP + 0.4, JOY.z);
  device.add(stem);

  // --- screen -----------------------------------------------------------------------------
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(27, 27), new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.25, metalness: 0.3 }));
  glass.rotation.x = -Math.PI / 2;
  glass.position.set(0.4, LID_TOP - 1.9, 0.1);
  device.add(glass);
  const tex = new THREE.CanvasTexture(screenCanvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const screenMat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
  const screenMesh = new THREE.Mesh(new THREE.PlaneGeometry(23.4, 23.4), screenMat);
  screenMesh.rotation.x = -Math.PI / 2;
  screenMesh.position.set(0.4, LID_TOP - 1.85, 0.1);
  device.add(screenMesh);

  // --- keyboard legend: which key hits which cap ----------------------------------------------
  function label(text, w = 5, h = 2.6) {
    const cv = document.createElement("canvas"); cv.width = 128 * (w / 2.6); cv.height = 128;
    const g = cv.getContext("2d");
    g.fillStyle = "rgba(10,10,14,0.82)";
    g.beginPath(); g.roundRect(4, 4, cv.width - 8, cv.height - 8, 28); g.fill();
    g.strokeStyle = "#ffdc00"; g.lineWidth = 6; g.stroke();
    g.fillStyle = "#ffdc00"; g.font = "bold 72px Menlo, monospace"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(text, cv.width / 2, cv.height / 2 + 4);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false }));
    sp.scale.set(w, h, 1); sp.renderOrder = 10;
    device.add(sp);
    return sp;
  }
  const KEYCAP_LABEL = { A: "9", B: "6", X: "3", Y: "." };
  for (const k of ["A", "B", "X", "Y"]) label(KEYCAP_LABEL[k], 3.2, 2.6).position.set(CAP_X + 7.5, LID_TOP + 1.2, CAP_Z[k]);
  label("W", 3, 2.6).position.set(JOY.x, LID_TOP + 1.5, JOY.z - 7.5);
  label("S", 3, 2.6).position.set(JOY.x, LID_TOP + 1.5, JOY.z + 7.5);
  label("A", 3, 2.6).position.set(JOY.x - 7.5, LID_TOP + 1.5, JOY.z);
  label("D", 3, 2.6).position.set(JOY.x + 7.5, LID_TOP + 1.5, JOY.z);
  label("space", 7, 2.6).position.set(JOY.x, LID_TOP + 6.5, JOY.z);

  // --- input ------------------------------------------------------------------------------
  const ray = new THREE.Raycaster();
  const ptr = new THREE.Vector2();
  const targets = [...Object.values(caps), joy];
  const down = { A: false, B: false, X: false, Y: false, up: false, down: false, left: false, right: false, press: false };
  let activeKey = null;

  function pick(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    ptr.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ptr, camera);
    const hit = ray.intersectObjects(targets, false)[0];
    if (!hit) return null;
    const k = hit.object.userData.key;
    if (k !== "joy") return k;
    const dx = hit.point.x - JOY.x, dz = hit.point.z - JOY.z;
    if (Math.max(Math.abs(dx), Math.abs(dz)) < 1.4) return "press";
    return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? "right" : "left") : dz > 0 ? "down" : "up";
  }
  renderer.domElement.addEventListener("pointerdown", (ev) => {
    if (onGrab) onGrab();
    const k = pick(ev);
    if (!k) return;
    ev.preventDefault();
    activeKey = k; controls.enabled = false;
    onKey(k, true);
  });
  window.addEventListener("pointerup", () => { if (activeKey) { onKey(activeKey, false); activeKey = null; } controls.enabled = true; });
  renderer.domElement.addEventListener("pointermove", (ev) => { if (!activeKey) renderer.domElement.style.cursor = pick(ev) ? "pointer" : "grab"; });

  // --- loop -------------------------------------------------------------------------------
  function resize() {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = "100%"; renderer.domElement.style.height = "100%";
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  const lerp = (a, b, t) => a + (b - a) * t;
  function animate() {
    requestAnimationFrame(animate);
    for (const k of ["A", "B", "X", "Y"]) caps[k].position.y = lerp(caps[k].position.y, CAP_REST - (down[k] ? CAP_PRESS : 0), 0.4);
    joy.rotation.x = lerp(joy.rotation.x, (down.down ? JOY_TILT : 0) - (down.up ? JOY_TILT : 0), 0.35);
    joy.rotation.z = lerp(joy.rotation.z, (down.left ? JOY_TILT : 0) - (down.right ? JOY_TILT : 0), 0.35);
    joy.position.y = lerp(joy.position.y, JOY.y - (down.press ? JOY_PRESS : 0), 0.4);
    if (!container.hidden) { controls.update(); renderer.render(scene, camera); }
  }
  animate();

  return {
    setKey(name, v) { if (name in down) down[name] = v; },
    updateScreen() { tex.needsUpdate = true; },
    setBacklight(frac) { screenMat.color.setScalar(0.12 + 0.88 * frac); },
    setLed(on) { led.intensity = on ? 30 : 0; },
    resize,
  };
}
