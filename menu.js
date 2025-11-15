import * as THREE from './modules/three.module.js';
import { GLTFLoader } from './modules/gltfloader.js';

let scene, camera, renderer, model;
const container = document.getElementById('model-viewer');

if (container) {
  // 1. Inisialisasi Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x222222); 

  // 2. Inisialisasi Kamera
  camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 1000);
  camera.position.set(0, 0.5, 1.5); // Sesuaikan posisi kamera untuk alat medis

  // 3. Inisialisasi Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace; 
  container.appendChild(renderer.domElement);

  // 4. Tambahkan Pencahayaan
  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 2);
  scene.add(hemiLight);
  const dirLight = new THREE.DirectionalLight(0xffffff, 2);
  dirLight.position.set(5, 5, 5);
  scene.add(dirLight);

  // 5. Muat Model Alat Medis (Penlight sebagai default)
  const loader = new GLTFLoader();
  const modelPath = './assets/penlight-compressed.glb'; // Path ke Penlight
  loader.load(
      modelPath, 
      (gltf) => {
          model = gltf.scene;
          
          // --- MODIFIKASI: Hitung bounding box untuk memusatkan model ---
          const box = new THREE.Box3().setFromObject(model);
          const center = box.getCenter(new THREE.Vector3());
          model.position.sub(center); // Pindahkan ke tengah
          
          // Skala model agar pas (disesuaikan)
          const size = box.getSize(new THREE.Vector3());
          const maxDim = Math.max(size.x, size.y, size.z);
          const scale = 1.0 / maxDim; // Skala agar pas (ukuran 1)
          model.scale.set(scale, scale, scale);

          scene.add(model);
      },
      undefined,
      (e) => console.error(e)
  );

  // 6. Animate Loop (Hanya berputar)
  function animate() {
      requestAnimationFrame(animate);

      if (model) {
          model.rotation.y += 0.01; // Putar model
      }
      
      if (renderer) renderer.render(scene, camera);
  }
  animate();

  // 7. Handle Resize
  window.addEventListener('resize', () => {
      if (!container || !renderer) return;
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
  });
}