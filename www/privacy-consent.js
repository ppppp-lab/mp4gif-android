// 首次启动隐私协议拦截：同意前不展示应用内容
(function () {
  'use strict';

  if (localStorage.getItem('mp4gif_privacy_consent') === '1') return;
  if (document.getElementById('privacyConsentOverlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'privacyConsentOverlay';
  overlay.innerHTML = `
    <div class="consent-card">
      <div class="consent-head">
        <div class="consent-title">隐私政策确认</div>
        <div class="consent-sub">请阅读并同意隐私政策后使用本应用</div>
      </div>
      <div class="consent-scroll">
        <h3>引言</h3>
        <p>MP4转GIF工具是一款完全离线的本地工具，视频、图片和 GIF 素材仅在您的设备本地处理，不会上传到任何服务器。</p>
        <h3>信息收集</h3>
        <p>本应用不收集、不存储、不共享任何个人信息。您导入的素材仅用于本地转换和编辑。</p>
        <h3>权限使用</h3>
        <p>旧版 Android 系统需要存储权限用于读取视频和保存 GIF；新版系统使用系统文件选择器和媒体库，无需存储权限。本应用不申请网络权限。</p>
        <h3>第三方服务</h3>
        <p>本应用不集成广告、统计、推送等第三方 SDK，不向任何第三方传输数据。</p>
        <h3>数据存储与删除</h3>
        <p>所有素材和生成结果仅保存在设备本地，删除应用或文件后即被移除。</p>
      </div>
      <div class="consent-actions" id="consentActions">
        <button class="btn-consent btn-consent-ghost" id="consentDisagree">不同意并退出</button>
        <button class="btn-consent btn-consent-primary" id="consentAgree">同意并继续</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  function showDenied() {
    const card = overlay.querySelector('.consent-card');
    card.innerHTML = `
      <div class="consent-head">
        <div class="consent-title">无法进入应用</div>
      </div>
      <div class="consent-denied">
        <div class="consent-denied-text">您需要同意隐私政策后才能使用本应用。</div>
        <button class="btn-consent btn-consent-primary" id="consentBack">返回重新阅读</button>
        <button class="btn-consent btn-consent-ghost" id="consentExit">退出应用</button>
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
})();
