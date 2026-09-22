// Scroll-flash system (paired with src/app/scrollbars.css).
// Marks the element actually being scrolled with .app-scrolling for
// SCROLLBAR_FLASH_MS; its scrollbar shows as a dim sliver only during that
// window and vanishes at rest. One capture-phase listener covers every
// scrolling region in the app (agenda, taste strip, thread, goals, menus).

const SCROLLBAR_FLASH_MS = 900;

const timers = new WeakMap<HTMLElement, number>();

function markScrolling(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return;
  target.classList.add('app-scrolling', 'app-scroll-flash');
  const existing = timers.get(target);
  if (existing) window.clearTimeout(existing);
  const timer = window.setTimeout(() => {
    target.classList.remove('app-scrolling');
  }, SCROLLBAR_FLASH_MS);
  timers.set(target, timer);
}

export function installScrollbarFlash(): () => void {
  const onScroll = (event: Event) => {
    markScrolling(event.target);
  };
  // Capture: scroll events don't bubble, but capture sees them all.
  document.addEventListener('scroll', onScroll, { capture: true, passive: true });
  return () => document.removeEventListener('scroll', onScroll, { capture: true });
}