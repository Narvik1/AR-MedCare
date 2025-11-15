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
const placed = []; 

const loader = new GLTFLoader();
const modelCache = {};      
let placedAnchor = null;    
let currentModel = null;    
let groupPlaced = false;    
let modelPrefab = null;     

// Referensi UI
let infoPanel, infoTitle, infoDesc;
let sidebarMenu, assetListContainer, btnAssets, btnInfoToggle, btnExitAr;

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
  
  // Latar belakang di-handle oleh CSS, buat scene transparan
  scene.background = null; 
  renderer.setClearAlpha(0); 

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);
  camera.position.set(0, 1.6, 0); 

  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.2);
  scene.add(hemi);
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(1, 1.5, 0.5);
  scene.add(dirLight);

  // Muat Penlight untuk fallback (Foto 2)
  const modelPath = './assets/penlight-compressed.glb'; 
  loader.load(modelPath, (gltf) => {
      modelPrefab = gltf.scene;
      modelPrefab.scale.set(0.5, 0.5, 0.5); 
      modelPrefab.position.set(0, 1, -2); 
      modelPrefab.name = 'AlatMedis_Prefab';
  }, undefined, (e) => console.error(`Gagal load ${modelPath}`, e));

  // Ambil referensi ke panel info
  infoPanel = document.getElementById('info-panel');
  infoTitle = document.getElementById('info-title');
  infoDesc = document.getElementById('info-desc');
  
  // Implementasi Sidebar (FOTO 3 & 4)
  sidebarMenu = document.getElementById('sidebar-menu');
  assetListContainer = document.getElementById('asset-list-container');
  btnAssets = document.getElementById('btn-assets');
  btnInfoToggle = document.getElementById('btn-info-toggle');
  btnExitAr = document.getElementById('btn-exit-ar');

  btnAssets.addEventListener('click', toggleAssetList);
  btnInfoToggle.addEventListener('click', toggleInfoPanel);
  btnExitAr.addEventListener('click', exitAR);

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
  
  if (modelPrefab) {
      if(modelPrefab.parent !== scene) scene.add(modelPrefab); 
      modelPrefab.rotation.y += 0.01; 
  }
  
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

  if (modelPrefab) scene.remove(modelPrefab); 

  document.getElementById('overlayRoot').classList.add('ar-active');
  
  if (infoPanel) {
    infoTitle.textContent = "Mode AR Aktif";
    infoDesc.textContent = "Arahkan kamera ke lantai dan ketuk untuk menempatkan jangkar (anchor).";
    infoPanel.style.display = 'block'; 
  }

  sidebarMenu.style.display = 'none';
  assetListContainer.style.display = 'none';
  
  populateAssetList();

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
  
  if (infoPanel) infoPanel.style.display = 'none';
  sidebarMenu.style.display = 'none';
  assetListContainer.style.display = 'none';

  if (currentModel) {
      if(currentModel.parent) currentModel.parent.remove(currentModel);
      currentModel = null;
  }
  if (placedAnchor) {
      if(placedAnchor.parent) placedAnchor.parent.remove(placedAnchor);
      placedAnchor = null;
  }

  placed.length = 0; 
  groupPlaced = false;
  
  renderer.domElement.removeEventListener('pointerup', domSelectFallback);
  renderer.domElement.removeEventListener('click', domSelectFallback, domOpts);
  renderer.domElement.addEventListener('touchend', domSelectFallback, domOpts);

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
  if (arRoot) { scene.remove(arRoot); arRoot = null; }
  
  requestAnimationFrame(animateFallback); 
}

// ===== XR render loop =====
function renderXR(time, frame) {
  if (!xrSession || !frame) return;

  lastXRFrame = frame;
  const session = frame.session;
  if (!refSpace) refSpace = renderer.xr.getReferenceSpace?.() || refSpace;

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
  if (!reticle || !reticle.visible || groupPlaced) return; 

  const now = performance.now();
  if (now - lastSpawnTs < 160) return;
  lastSpawnTs = now;

  let anchored = false;
  try {
    if (lastHit && typeof lastHit.createAnchor === 'function') {
      const anchor = await lastHit.createAnchor();
      if (anchor?.anchorSpace) {
        
        placedAnchor = new THREE.Group();
        placedAnchor.matrixAutoUpdate = false;
        
        placed.push({ mesh: placedAnchor, anchorSpace: anchor.anchorSpace }); 
        (arRoot ?? scene).add(placedAnchor);
        
        anchored = true;
        groupPlaced = true; 
      }
    }
  } catch (e) {
    anchored = false; 
  }

  if (anchored) {
    sidebarMenu.style.display = 'flex';
    if (infoPanel) {
      infoTitle.textContent = "Pilih Alat Medis";
      infoDesc.textContent = "Silakan pilih alat medis dari menu di sebelah kiri.";
    }
  }
}

// --- FUNGSI BARU: Logika Sidebar ---

function populateAssetList() {
  assetListContainer.innerHTML = ''; 

  if (typeof ALAT_MEDIS_DATA === 'undefined') {
    console.error("Data alat medis (ALAT_MEDIS_DATA) tidak ditemukan.");
    return;
  }

  for (const key in ALAT_MEDIS_DATA) {
    const data = ALAT_MEDIS_DATA[key];
    const button = document.createElement('button');
    button.textContent = data.nama;
    button.dataset.key = key; 
    
    button.addEventListener('click', () => {
      loadModel(key);
      assetListContainer.style.display = 'none'; 
    });
    
    assetListContainer.appendChild(button);
  }
}

// --- MODIFIKASI UTAMA DI SINI (LOGIKA SKALA) ---
function loadModel(key) {
  if (!placedAnchor) return; 

  const data = ALAT_MEDIS_DATA[key];
  if (!data) return;

  if (currentModel) {
    placedAnchor.remove(currentModel);
    currentModel = null; 
  }

  if (infoPanel) {
    infoTitle.textContent = data.nama;
    infoDesc.textContent = data.deskripsi;
  }
  
  // Fungsi untuk menerapkan skala & posisi
  const setupModel = (model) => {
    // --- LOGIKA SKALA BARU ---
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    
    // Atur skala agar sisi terpanjangnya 0.5 meter (50cm)
    const scale = 0.5 / maxDim; 
    model.scale.set(scale, scale, scale);
    
    // Pindahkan model agar pivot-nya di tengah lantai
    // (center.y dikurangi setengah tinggi agar model 'duduk' di lantai)
    model.position.sub(center);
    model.position.y -= (size.y * scale / 2); 
    // --- AKHIR LOGIKA SKALA BARU ---

    currentModel = model;
    placedAnchor.add(currentModel);
  };
  // ---

  // 3. Cek cache
  if (modelCache[key]) {
    const cachedModel = modelCache[key].clone();
    setupModel(cachedModel);
  } else {
    // 4. Load model baru jika tidak ada di cache
    loader.load(data.path, (gltf) => {
      modelCache[key] = gltf.scene; // Simpan prefab-nya
      const newModel = modelCache[key].clone();
      setupModel(newModel);
    }, undefined, (e) => {
      console.error(`Gagal load ${data.path}`, e);
      if (infoPanel) infoDesc.textContent = "Gagal memuat model.";
    });
  }
}
// --- AKHIR MODIFIKASI ---

function toggleAssetList() {
  const isVisible = assetListContainer.style.display === 'block';
  assetListContainer.style.display = isVisible ? 'none' : 'block';
}

function toggleInfoPanel() {
  if (!infoPanel) return;
  const isVisible = infoPanel.style.display === 'block';
  infoPanel.style.display = isVisible ? 'none' : 'block';
}

function exitAR() {
  if (xrSession) {
    xrSession.end();
  }
}
// ---

function domSelectFallback(e) {
  if (e.target?.closest?.('.xr-btn')) return;
  if (renderer.xr.isPresenting) onSelect();
}