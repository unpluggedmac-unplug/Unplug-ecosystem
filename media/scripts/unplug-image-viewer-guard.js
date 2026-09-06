(function () {
  'use strict';

  function protectViewer(root) {
    const scope = root && root.querySelectorAll ? root : document;
    if (root && root.matches && root.matches('.unplug-lightbox')) {
      root.setAttribute('data-unplug-no-lightbox', 'true');
    }
    scope.querySelectorAll('.unplug-lightbox').forEach(function (box) {
      box.setAttribute('data-unplug-no-lightbox', 'true');
    });
  }

  protectViewer(document);
  new MutationObserver(function (mutations) {
    mutations.forEach(function (mutation) {
      mutation.addedNodes.forEach(function (node) {
        if (node.nodeType === 1) protectViewer(node);
      });
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
