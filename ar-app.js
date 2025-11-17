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
let hasFoundPlaneOnce = false; 

// Referensi UI
let infoPanel, infoTitle, infoDesc;
let sidebarMenu, assetListContainer, btnAssets, btnInfoToggle, btnExitAr;
let scanOverlay; 

// --- GESTUR: Variabel untuk melacak status sentuhan ---
const gestureState = {
    touchCount: 0,
    isInteracting: false,
    mode: null, 
    isPanning: false, 
    lastScale: 1,
    lastRotation: 0,
    initialTouchDistance: 0,
    initialTouchAngle: 0
};

// --- GESTUR: Variabel untuk Raycasting ---
const raycaster = new THREE.Raycaster();
const touchPos = new THREE.Vector2();
// ---

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
  renderer.setClearAlpha(0); 

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);
  camera.position.set(0, 1.6, 0); 

  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.2);
  scene.add(hemi);
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(1, 1.5, 0.5);
  scene.add(dirLight);

  const modelPath = './assets/penlight-compressed.glb'; 
  loader.load(modelPath, (gltf) => {
      modelPrefab = gltf.scene;
      modelPrefab.scale.set(0.5, 0.5, 0.5); 
      modelPrefab.position.set(0, 1, -2); 
      modelPrefab.name = 'AlatMedis_Prefab';
  }, undefined, (e) => console.error(`Gagal load ${modelPath}`));

  // Ambil referensi ke panel info
  infoPanel = document.getElementById('info-panel');
  infoTitle = document.getElementById('info-title');
  infoDesc = document.getElementById('info-desc');
  scanOverlay = document.getElementById('scan-overlay');
  
  // Implementasi Sidebar
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

  // --- GESTUR: Tambahkan event listener untuk sentuhan ---
  window.addEventListener('touchstart', onTouchStart, { passive: false });
  window.addEventListener('touchmove', onTouchMove, { passive: false });
  window.addEventListener('touchend', onTouchEnd, { passive: false });
  // ---
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
  hasFoundPlaneOnce = false;

  if (modelPrefab) scene.remove(modelPrefab); 

  document.getElementById('overlayRoot').classList.add('ar-active');
  
  if (infoPanel) 
      infoPanel.textContent = "Perhatian";
      infoDesc.textContent = "Pastikan permukaan lantai tidak memantulkan cahaya berlebihan dan Anda berada di ruangan yang memiliki cukup pencahayaan.";
      infoPanel.style.display = 'block'; 
  
  if (scanOverlay) scanOverlay.style.display = 'flex'; 

  sidebarMenu.style.display = 'none';
  assetListContainer.style.display = 'none';
  
  populateAssetList();

  refSpace = await xrSession.requestReferenceSpace('local');

  arRoot = new THREE.Group(); 
  arRoot.name = 'ar-session-root';
  scene.add(arRoot);

  xrSession.addEventListener('select', onSelectLike); // Hanya 'select' untuk tap

  controller = renderer.xr.getController(0);
  scene.add(controller);

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
  if (scanOverlay) scanOverlay.style.display = 'none';
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

  if (controller) {
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

  let hitTestResults = null;
  if (hitTestSource) {
      hitTestResults = frame.getHitTestResults(hitTestSource);
  }

  // --- REVISI: Logika Panning (Move) 1-Jari ---
  if (gestureState.isPanning && groupPlaced && placedAnchor && hitTestResults && hitTestResults.length > 0) {
      const pose = hitTestResults[0].getPose(refSpace);
      if (pose) {
          placedAnchor.matrix.fromArray(pose.transform.matrix);
          placedAnchor.matrixAutoUpdate = false;
          placedAnchor.updateMatrixWorld(true);
      }
  }
  // ---

  const haveReticle = updateReticle(reticle, frame, hitTestSource, refSpace);
  
  if (!haveReticle || groupPlaced || gestureState.isInteracting) { // Sembunyikan reticle saat gestur
    lastHit = null;
    if(reticle) reticle.visible = false;
  } else {
    if (hitTestResults && hitTestResults.length > 0) {
        lastHit = hitTestResults[0]; 
        if (hasFoundPlaneOnce === false) {
            hasFoundPlaneOnce = true;
            if (scanOverlay) scanOverlay.style.display = 'none'; 
            
            if (infoPanel) {
                infoTitle.textContent = "Lantai Terdeteksi";
                infoDesc.textContent = "Ketuk untuk menempatkan alat.";
                infoPanel.style.display = 'block';
            }
        }
    }
  }

  // Update posisi anchor
  for (const p of placed) {
    if (!p.anchorSpace) continue; 
    if (!gestureState.isPanning) { 
        const apose = frame.getPose(p.anchorSpace, refSpace);
        if (apose) {
          p.mesh.matrix.fromArray(apose.transform.matrix);
          p.mesh.matrixAutoUpdate = false;
          p.mesh.updateMatrixWorld(true);
        }
    }
  }

  renderer.render(scene, camera);
}

// ===== Interaksi =====
function onSelectLike(event) {
  if (gestureState.isInteracting) return;
  
  if (event.type === 'select' && event.inputSource.targetRayMode === 'screen') {
      onSelect();
  }
}

async function onSelect() {
  if (gestureState.isInteracting) return; 
  if (!reticle || !reticle.visible || groupPlaced) return; 

  const now = performance.now();
  if (now - lastSpawnTs < 160) return;
  lastSpawnTs = now;

  if (scanOverlay) scanOverlay.style.display = 'none'; 

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
      infoPanel.style.display = 'block';
    }
  }
}

// --- FUNGSI Logika Sidebar ---
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
  
  const setupModel = (model) => {
    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const scale = 0.5 / maxDim; 
    model.scale.set(scale, scale, scale);
    model.position.sub(center);
    model.position.y -= (size.y * scale / 2); 
    currentModel = model;
    placedAnchor.add(currentModel);
    gestureState.lastScale = currentModel.scale.x;
    gestureState.lastRotation = currentModel.rotation.y;
  };

  if (modelCache[key]) {
    const cachedModel = modelCache[key].clone();
    setupModel(cachedModel);
  } else {
    loader.load(data.path, (gltf) => {
      modelCache[key] = gltf.scene; 
      const newModel = modelCache[key].clone();
      setupModel(newModel);
    }, undefined, (e) => {
      console.error(`Gagal load ${data.path}`, e);
      if (infoPanel) infoDesc.textContent = "Gagal memuat model.";
    });
  }
}

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

// --- GESTUR: FUNGSI HANDLER SENTUHAN (REVISI BESAR) ---

function onTouchStart(event) {
    // Hanya jalankan gestur JIKA anchor sudah ditempatkan
    if (!xrSession || !groupPlaced) return;

    // Cek apakah sentuhan di atas UI, jika ya, abaikan gestur
    if (event.target.closest('#sidebar-menu, #asset-list-container, #info-panel, .ui-btn')) {
        return;
    }

    event.preventDefault();
    const touches = event.touches;
    gestureState.touchCount = touches.length;

    if (touches.length === 1) {
        // --- REVISI: Logika 1 Jari (Pan) ---
        // 1. Normalisasi koordinat sentuh (-1 s/d +1)
        touchPos.x = (touches[0].clientX / window.innerWidth) * 2 - 1;
        touchPos.y = -(touches[0].clientY / window.innerHeight) * 2 + 1;
        
        // 2. Tembakkan raycaster dari kamera
        raycaster.setFromCamera(touchPos, camera);
        
        // 3. Cek apakah raycaster mengenai 'currentModel'
        if (currentModel) {
            const intersects = raycaster.intersectObject(currentModel, true);
            
            if (intersects.length > 0) {
                // YA, SENTUHAN MENGENAI MODEL!
                gestureState.mode = 'pan';
                gestureState.isInteracting = true;
                gestureState.isPanning = true; 
                
                // Lepaskan dari jangkar lama agar bisa bergerak
                if (placed.length > 0) {
                    placed[0].anchorSpace = null; // Lepaskan!
                }
            }
        }
        
    } else if (touches.length === 2 && currentModel) {
        // --- 2 Jari: Mulai Scale & Rotate ---
        gestureState.mode = 'scale-rotate';
        gestureState.isInteracting = true;
        gestureState.isPanning = false; 

        const dx = touches[0].pageX - touches[1].pageX;
        const dy = touches[0].pageY - touches[1].pageY;
        
        gestureState.initialTouchDistance = Math.sqrt(dx * dx + dy * dy);
        gestureState.initialTouchAngle = Math.atan2(dy, dx);
        
        gestureState.lastScale = currentModel.scale.x;
        gestureState.lastRotation = currentModel.rotation.y;
    }
}

function onTouchMove(event) {
    if (!xrSession || !gestureState.isInteracting || !groupPlaced) return;

    event.preventDefault();
    const touches = event.touches;

    if (gestureState.mode === 'pan' && touches.length === 1) {
        // Logika pemindahan (pan) ada di renderXR()
        // Kita hanya perlu set flag, yang sudah diatur di onTouchStart

    } else if (gestureState.mode === 'scale-rotate' && touches.length === 2 && currentModel) {
        // --- 2 Jari: Hitung Skala & Rotasi ---
        const dx = touches[0].pageX - touches[1].pageX;
        const dy = touches[0].pageY - touches[1].pageY;

        // Hitung Skala (Pinch)
        const newDistance = Math.sqrt(dx * dx + dy * dy);
        const newScale = (newDistance / gestureState.initialTouchDistance) * gestureState.lastScale;
        currentModel.scale.set(newScale, newScale, newScale);

        // Hitung Rotasi (Twist)
        const newAngle = Math.atan2(dy, dx);
        const deltaAngle = newAngle - gestureState.initialTouchAngle;
        currentModel.rotation.y = gestureState.lastRotation + deltaAngle;
    }
}

function onTouchEnd(event) {
    if (!xrSession) return;
    
    // --- REVISI: Buat jangkar baru setelah panning ---
    if (gestureState.isPanning && lastXRFrame && placedAnchor && hitTestSource) {
        // Ambil hit-test terakhir dari frame terakhir (pusat layar)
        const results = lastXRFrame.getHitTestResults(hitTestSource);
        if (results.length > 0) {
            const hit = results[0];
            // Buat anchor baru di posisi 'drop'
            hit.createAnchor().then(anchor => {
                if (placed.length > 0) {
                    placed[0].anchorSpace = anchor.anchorSpace; // Kunci ke anchor baru
                    
                    // Paksa update matrix ke anchor baru (untuk frame ini)
                    const pose = lastXRFrame.getPose(anchor.anchorSpace, refSpace);
                    if (pose) {
                        placed[0].mesh.matrix.fromArray(pose.transform.matrix);
                    }
                }
            }).catch(err => {
                console.error("Gagal membuat anchor baru setelah pan:", err);
            });
        }
    }
    // ---

    if (gestureState.isInteracting && event.touches.length === 0) {
        if (currentModel) {
            gestureState.lastScale = currentModel.scale.x;
            gestureState.lastRotation = currentModel.rotation.y;
        }
    }
    
    // Reset status
    gestureState.isInteracting = false;
    gestureState.isPanning = false;
    gestureState.mode = null;
    gestureState.touchCount = event.touches.length;
    
    if (groupPlaced && currentModel && event.touches.length === 1) {
        // Kita tidak re-initialize pan di sini lagi,
        // pengguna harus mengangkat jari dan menyentuh objek lagi.
    }
}
// --- AKHIR FUNGSI GESTUR ---