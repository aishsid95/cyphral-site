/**
 * Marks data-scrolled="true" on the sticky header when the user has
 * scrolled past 8px, which CSS uses to fade in the background and bottom
 * border. Referenced via <script src> (not inline) so it's CSP-safe.
 */
(function () {
  const header = document.getElementById('site-header');
  if (!header) return;
  const border = header.querySelector('.header-border');
  const threshold = 8;

  function update() {
    const scrolled = window.scrollY > threshold;
    if (scrolled) {
      header!.dataset.scrolled = 'true';
      header!.classList.add('bg-neutral-50/85', 'backdrop-blur-md');
      if (border) border.classList.add('bg-neutral-200');
    } else {
      header!.dataset.scrolled = 'false';
      header!.classList.remove('bg-neutral-50/85', 'backdrop-blur-md');
      if (border) border.classList.remove('bg-neutral-200');
    }
  }

  update();
  window.addEventListener('scroll', update, { passive: true });
})();

export {}; // makes this a module, isolating its scope from the other page scripts
