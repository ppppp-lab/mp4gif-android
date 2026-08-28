// 首次启动隐私协议拦截：同意前不展示应用内容
(function () {
  'use strict';

  function initConsent() {
    if (localStorage.getItem('mp4gif_privacy_consent') === '1') return;
    if (document.getElementById('privacyConsentOverlay')) return;
    if (!document.body) return;

    const overlay = document.createElement('div');
    overlay.id = 'privacyConsentOverlay';
    overlay.innerHTML = `
      <div class="consent-card">
        <div class="consent-head">
          <div class="consent-title">${t('consent.title')}</div>
          <div class="consent-sub">${t('consent.sub')}</div>
        </div>
        <div class="consent-scroll">
          <h3>${t('consent.introTitle')}</h3>
          <p>${t('consent.introBody')}</p>
          <h3>${t('consent.collectTitle')}</h3>
          <p>${t('consent.collectBody')}</p>
          <h3>${t('consent.permissionTitle')}</h3>
          <p>${t('consent.permissionBody')}</p>
          <h3>${t('consent.thirdTitle')}</h3>
          <p>${t('consent.thirdBody')}</p>
          <h3>${t('consent.dataTitle')}</h3>
          <p>${t('consent.dataBody')}</p>
        </div>
        <div class="consent-actions" id="consentActions">
          <button class="btn-consent btn-consent-ghost" id="consentDisagree">${t('consent.disagree')}</button>
          <button class="btn-consent btn-consent-primary" id="consentAgree">${t('consent.agree')}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    function showDenied() {
      const card = overlay.querySelector('.consent-card');
      card.innerHTML = `
        <div class="consent-head">
          <div class="consent-title">${t('consent.deniedTitle')}</div>
        </div>
        <div class="consent-denied">
          <div class="consent-denied-text">${t('consent.deniedText')}</div>
          <button class="btn-consent btn-consent-primary" id="consentBack">${t('consent.back')}</button>
          <button class="btn-consent btn-consent-ghost" id="consentExit">${t('consent.exit')}</button>
        </div>
      `;
      card.querySelector('#consentBack').onclick = () => location.reload();
      card.querySelector('#consentExit').onclick = () => {
        if (window.api && window.api.exitApp) {
          window.api.exitApp();
        }
      };
    }

    overlay.querySelector('#consentAgree').onclick = () => {
      localStorage.setItem('mp4gif_privacy_consent', '1');
      overlay.remove();
    };
    overlay.querySelector('#consentDisagree').onclick = showDenied;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initConsent);
  } else {
    initConsent();
  }
})();
