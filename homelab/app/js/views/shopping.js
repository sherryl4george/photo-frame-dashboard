// The wall display's Shopping tab is the same page the phones use (/shop), so there is one design and one set of
// behaviour to look after. It is shown full-bleed in a frame; touches inside it tell this page the screen is in use.
(function () {
  'use strict';
  window.addEventListener('message', function (e) {
    if (e.origin === location.origin && e.data && e.data.hq === 'touch') App.resetIdle();
  });
  App.register('shopping', {
    show: function (el) {
      if (!el.firstChild) el.innerHTML = '<iframe class="shop-frame" src="/shop?embed=1" title="Shopping"></iframe>';
    },
    resume: function (el) {
      var f = el.querySelector('iframe');
      if (f && f.contentWindow) f.contentWindow.postMessage({ hq: 'refresh' }, location.origin);
    }
  });
})();
