const menuToggle = document.querySelector('[data-menu-toggle]');
const navigation = document.querySelector('[data-nav]');
const year = document.querySelector('[data-year]');

function setMenu(open) {
  menuToggle?.setAttribute('aria-expanded', String(open));
  navigation?.classList.toggle('is-open', open);
  document.body.classList.toggle('menu-open', open);
  const label = menuToggle?.querySelector('.sr-only');
  if (label) label.textContent = open ? 'Close navigation' : 'Open navigation';
}

menuToggle?.addEventListener('click', () => setMenu(menuToggle.getAttribute('aria-expanded') !== 'true'));
navigation?.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => setMenu(false)));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') setMenu(false); });
window.addEventListener('resize', () => { if (window.innerWidth > 1040) setMenu(false); });
if (year) year.textContent = String(new Date().getFullYear());
