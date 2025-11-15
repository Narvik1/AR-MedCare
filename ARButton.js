// Tombol toggle Enter ↔ Exit AR (terpasang di #hud, tetap terlihat saat AR via DOM overlay)
export const ARButton = {
  createButton(renderer, {
    referenceSpaceType = 'local',
    sessionInit = {
      requiredFeatures: ['hit-test'],                        // wajib untuk reticle
      optionalFeatures: ['dom-overlay','local','anchors'],   // anchors opsional
      domOverlay: { root: document.getElementById('overlayRoot') || document.body }
    }
  } = {}) {
    const btn = document.createElement('button');
    btn.className = 'xr-btn';
    btn.textContent = 'Enter AR';

    let currentSession = null;
    const setIdle   = () => { btn.classList.remove('exit'); btn.textContent = 'Enter AR'; };
    const setActive = () => { btn.classList.add('exit');    btn.textContent = 'Exit AR';  };

    btn.addEventListener('click', async () => {
      if (!navigator.xr) return;

      // EXIT
      if (currentSession) { currentSession.end(); return; }

      // ENTER
      const ok = await navigator.xr.isSessionSupported('immersive-ar').catch(() => false);
      if (!ok) { btn.textContent = 'AR unsupported'; btn.disabled = true; return; }

      try{
        const session = await navigator.xr.requestSession('immersive-ar', sessionInit);
        currentSession = session;

        renderer.xr.setReferenceSpaceType(referenceSpaceType);
        renderer.xr.setSession(session);
        setActive();

        session.addEventListener('end', () => {
          currentSession = null;
          setIdle();
        });
      }catch(e){ console.warn('Failed to start AR:', e); }
    });

    (document.getElementById('hud') || document.body).appendChild(btn);
    return btn;
  }
};
