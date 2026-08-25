// 首页：拍摄视频 → 自动进入 MP4 转 GIF
(function () {
  'use strict';

  const btn = document.getElementById('btnOpenCamera');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    if (window.api && window.api.openVideoCamera) {
      try {
        const paths = await window.api.openVideoCamera(60);
        if (paths && paths[0]) {
          location.href = 'converter.html?video=' + encodeURIComponent(paths[0]);
        }
      } catch (e) {
        location.href = 'converter.html';
      }
    } else {
      location.href = 'converter.html';
    }
  });
})();
