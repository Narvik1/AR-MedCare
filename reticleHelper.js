import * as THREE from './modules/three.module.js';

/** Cincin reticle: matrixAutoUpdate=false, default invisible. */
export function createReticle({
  innerRadius = 0.15,
  outerRadius = 0.20,
  segments    = 32,
  color       = 0x00ff00,
  opacity     = 1.0
} = {}) {
  const geo = new THREE.RingGeometry(innerRadius, outerRadius, segments).rotateX(-Math.PI/2);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity });
  const ret = new THREE.Mesh(geo, mat);
  ret.matrixAutoUpdate = false;
  ret.visible = false;
  ret.name = 'reticle';
  return ret;
}

/** Buat XRHitTestSource (viewer space) dan auto-cancel saat session end. */
export async function createHitTestSource(session) {
  const viewerSpace   = await session.requestReferenceSpace('viewer');
  const hitTestSource = await session.requestHitTestSource({ space: viewerSpace });

  const cancel = () => { try { hitTestSource.cancel?.(); } catch {} };
  const onEnd  = () => { cancel(); session.removeEventListener('end', onEnd); };
  session.addEventListener('end', onEnd);

  return { hitTestSource, viewerSpace, cancel };
}

/** Update transform & visibility reticle dari XRFrame. */
export function updateReticle(reticle, frame, hitTestSource, referenceSpace) {
  if (!reticle || !frame || !hitTestSource) { if (reticle) reticle.visible = false; return false; }
  const results = frame.getHitTestResults(hitTestSource);
  if (results.length === 0) { reticle.visible = false; return false; }

  const pose = results[0].getPose(referenceSpace);
  if (!pose) { reticle.visible = false; return false; }

  reticle.matrix.fromArray(pose.transform.matrix);
  reticle.visible = true;
  return true;
}

/** Bersihkan reticle dari scene + GPU memory. */
export function disposeReticle(reticle) {
  if (!reticle) return;
  reticle.parent?.remove?.(reticle);
  reticle.geometry?.dispose?.();
  const mats = Array.isArray(reticle.material) ? reticle.material : [reticle.material];
  mats.forEach(m => m?.dispose?.());
}
