import * as THREE from './modules/three.module.js';
import { ARButton } from './ARButton.js';
import { createReticle, createHitTestSource, updateReticle, disposeReticle } from './reticleHelper.js';
import { GLTFLoader } from './modules/gltfloader.js';

// ===== Globals =====
let renderer, scene;
let camera;
let controller;
let reticle;
let hitTestSource = null, hitCancel = null;
let xrSession = null;
let arRoot = null;
let lastSpawnTs = 0;

let refSpace = null;
let lastXRFrame = null;
let lastHit = null;
const placed = []; // Array untuk objek yang ditempatkan

let modelPrefab = null; // Prefab untuk model alat medis
let groupPlaced = false;
const loader = new GLTFLoader();

// Referensi UI
let infoPanel, infoTitle, infoDesc;

// ===== Bootstrap =====
init();
animateFallback();

function init() {
  const glCanvas = document.createElement('canvas');
  const gl = glCanvas.getContext('webgl', { antialias: true });

  renderer = new THREE.WebGLRenderer({ canvas: glCanvas, context: gl, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  document.body.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = null;

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);
  camera.position.set(0, 1.6, 0); 

  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.2);
  scene.add(hemi);
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(1, 1.5, 0.5);
  scene.add(dirLight);

  // --- Muat SATU Model Alat Medis sebagai Prefab ---
  // GANTI PATH INI dengan path ke model Anda
  const modelPath = './assets/penlight-compressed.glb'; 
  loader.load(modelPath, (gltf) => {
      modelPrefab = gltf.scene;
      modelPrefab.scale.set(0.5, 0.5, 0.5); // Atur skala default
      modelPrefab.position.set(0, 0, -3); // Atur posisi fallback
      modelPrefab.name = 'AlatMedis_Prefab';
      scene.add(modelPrefab);
  }, undefined, (e) => console.error(`Gagal load ${modelPath}`, e));
  // ---

  // Ambil referensi ke panel info
  infoPanel = document.getElementById('info-panel');
  infoTitle = document.getElementById('info-title');
  infoDesc = document.getElementById('info-desc');

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  ARButton.createButton(renderer, {
    referenceSpaceType: 'local',
    sessionInit: {
      requiredFeatures: ['hit-test', 'anchors'], 
      optionalFeatures: ['dom-overlay','local'],
      domOverlay: { root: document.getElementById('overlayRoot') || document.body }
    }
  });

  renderer.xr.addEventListener('sessionstart', onSessionStart);
  renderer.xr.addEventListener('sessionend', onSessionEnd);
}

function animateFallback() {
  if (xrSession) return;
  requestAnimationFrame(animateFallback);
  
  if (modelPrefab) modelPrefab.rotation.y += 0.01; // Rotasi otomatis di menu
  
  renderer.render(scene, camera);
}

// ===== AR lifecycle =====
async function onSessionStart() {
  xrSession = renderer.xr.getSession(); 

  lastSpawnTs = 0;
  lastXRFrame = null;
  lastHit = null;
  placed.length = 0;
  groupPlaced = false; 

  if (modelPrefab) modelPrefab.visible = false; // Sembunyikan prefab

  document.getElementById('overlayRoot').classList.add('ar-active');
  if (infoPanel) {
    infoTitle.textContent = "Alat Medis";
    infoDesc.textContent = "Arahkan kamera ke lantai dan ketuk untuk menempatkan alat.";
  }

  refSpace = await xrSession.requestReferenceSpace('local');

  arRoot = new THREE.Group();
  arRoot.name = 'ar-session-root';
  scene.add(arRoot);

  xrSession.addEventListener('selectstart', onSelectLike);
  xrSession.addEventListener('select', onSelectLike);

  controller = renderer.xr.getController(0);
  controller.addEventListener('selectstart', onSelectLike);
  controller.addEventListener('select', onSelectLike);
  scene.add(controller);

  const domOpts = { passive: true };
  renderer.domElement.addEventListener('pointerup', domSelectFallback, domOpts);
  renderer.domElement.addEventListener('click', domSelectFallback, domOpts);
  renderer.domElement.addEventListener('touchend', domSelectFallback, domOpts);

  reticle = createReticle();
  scene.add(reticle);

  try {
    const r = await createHitTestSource(xrSession);
    hitTestSource = r.hitTestSource;
    hitCancel = r.cancel;
  } catch (e) {
    console.warn('Hit-test source unavailable:', e);
  }

  renderer.setAnimationLoop(renderXR);
}

function onSessionEnd() {
  renderer.setAnimationLoop(null);
  xrSession = null; 

  document.getElementById('overlayRoot').classList.remove('ar-active');

  placed.length = 0; 
  groupPlaced = false;

  if (modelPrefab) modelPrefab.visible = true; // Tampilkan lagi prefab
  
  renderer.domElement.removeEventListener('pointerup', domSelectFallback);
  renderer.domElement.removeEventListener('click', domSelectFallback);
  renderer.domElement.removeEventListener('touchend', domSelectFallback);

  if (controller) {
    controller.removeEventListener('selectstart', onSelectLike);
    controller.removeEventListener('select', onSelectLike);
    scene.remove(controller);
    controller = null;
  }

  try { hitCancel?.(); } catch {}
  hitCancel = null;
  hitTestSource = null;
  lastHit = null;
  lastXRFrame = null;

  if (reticle) { disposeReticle(reticle); reticle = null; }

  if (arRoot) {
    arRoot.traverse(obj => {
      if (obj.isMesh) {
        obj.geometry?.dispose?.();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach(m => m?.dispose?.());
      }
    });
    scene.remove(arRoot);
    arRoot = null;
  }
  
  requestAnimationFrame(animateFallback); 
}

// ===== XR render loop =====
function renderXR(time, frame) {
  if (!xrSession || !frame) return;

  lastXRFrame = frame;
  const session = frame.session;

  if (!refSpace) refSpace = renderer.xr.getReferenceSpace?.() || refSpace;

  // Tampilkan reticle HANYA jika belum ada objek yang ditempatkan
  const haveReticle = updateReticle(reticle, frame, hitTestSource, refSpace);
  if (!haveReticle || groupPlaced) { 
    lastHit = null;
    if(reticle) reticle.visible = false;
  } else {
    const results = frame.getHitTestResults(hitTestSource);
    if (results.length) lastHit = results[0];
  }

  for (const p of placed) {
    if (!p.anchorSpace) continue;
    const apose = frame.getPose(p.anchorSpace, refSpace);
    if (apose) {
      p.mesh.matrix.fromArray(apose.transform.matrix);
      p.mesh.matrixAutoUpdate = false;
      p.mesh.updateMatrixWorld(true);
    }
  }

  renderer.render(scene, renderer.xr.getCamera(camera));
}

// ===== Interaksi =====
function onSelectLike() { onSelect(); }

async function onSelect() {
  // Hanya tempatkan jika reticle terlihat dan BELUM ada objek
  if (!reticle || !reticle.visible || groupPlaced) return; 

  const now = performance.now();
  if (now - lastSpawnTs < 160) return;
  lastSpawnTs = now;

  // Jika prefab belum ter-load, jangan lakukan apa-apa
  if (!modelPrefab) return;

  // Kloning model prefab
  const mesh = modelPrefab.clone();
  mesh.visible = true; 
  mesh.name = "AlatMedis_Placed";
  mesh.position.set(0, 0, 0); 
  mesh.rotation.set(0, 0, 0);
  mesh.scale.set(0.5, 0.5, 0.5); // Set skala yang sama
  
  let anchored = false;
  try {
    if (lastHit && typeof lastHit.createAnchor === 'function') {
      const anchor = await lastHit.createAnchor();
      if (anchor?.anchorSpace) {
        (arRoot ?? scene).add(mesh);
        placed.push({ mesh, anchorSpace: anchor.anchorSpace }); 
        anchored = true;
        groupPlaced = true; // Tandai bahwa kita sudah menempatkan objek
      }
    }
  } catch (e) {
    anchored = false; 
  }

  if (!anchored) {
    mesh.applyMatrix4(reticle.matrix);
    mesh.matrixAutoUpdate = false;
    placed.push({ mesh }); 
    (arRoot ?? scene).add(mesh);
    groupPlaced = true; // Tandai bahwa kita sudah menempatkan objek
  }
  
  // --- BARU: Update panel info setelah objek ditempatkan ---
  if (infoPanel) {
    infoTitle.textContent = "Penlight"; // Ganti dengan nama alat
    infoDesc.textContent = "Ini adalah placeholder untuk deskripsi singkat alat medis yang muncul."; // Ganti dengan info
  }
}

function domSelectFallback(e) {
  if (e.target?.closest?.('.xr-btn')) return;
  if (renderer.xr.isPresenting) onSelect();
}