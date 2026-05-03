// ── Navbar scroll effect ──────────────────────────────────────────────
const navbar = document.getElementById('navbar');
window.addEventListener('scroll', () => {
  navbar.classList.toggle('scrolled', window.scrollY > 40);
}, { passive: true });

// ── Copy buttons ──────────────────────────────────────────────────────
document.querySelectorAll('.copy-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.target;
    const text = target
      ? document.getElementById(target)?.textContent?.trim()
      : btn.closest('.pull-row')?.querySelector('.pull-code')?.textContent?.trim();

    if (!text) return;

    navigator.clipboard.writeText(text).then(() => {
      const orig = btn.textContent;
      btn.textContent = 'copied!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = orig;
        btn.classList.remove('copied');
      }, 2000);
    }).catch(() => {
      // Fallback for browsers without clipboard API
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      btn.textContent = 'copied!';
      btn.classList.add('copied');
      setTimeout(() => {
        btn.textContent = 'copy';
        btn.classList.remove('copied');
      }, 2000);
    });
  });
});

// ── Nav pull button scrolls to hero pull command ──────────────────────
const navPullBtn = document.getElementById('nav-pull-btn');
if (navPullBtn) {
  navPullBtn.addEventListener('click', () => {
    const pullBlock = document.querySelector('.pull-block');
    if (pullBlock) {
      pullBlock.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => pullBlock.style.outline = '3px solid #c97c2a', 600);
      setTimeout(() => pullBlock.style.outline = '', 2000);
    }
  });
}

// ── Smooth scroll for anchor links ───────────────────────────────────
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const id = a.getAttribute('href').slice(1);
    const el = document.getElementById(id);
    if (el) {
      e.preventDefault();
      el.scrollIntoView({ behavior: 'smooth' });
    }
  });
});

// ── Intersection Observer: reveal feature cards ───────────────────────
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      revealObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.08 });

document.querySelectorAll('.feat-reveal').forEach((el, i) => {
  el.style.transitionDelay = `${(i % 4) * 60}ms`;
  revealObserver.observe(el);
});

// ── Docs sidebar: highlight active section on scroll ─────────────────
if (document.querySelector('.docs-sidebar')) {
  const sections = document.querySelectorAll('.docs-content [id]');
  const navLinks = document.querySelectorAll('.docs-sidebar-nav a');

  const sectionObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        navLinks.forEach(l => l.classList.remove('active'));
        const active = document.querySelector(`.docs-sidebar-nav a[href="#${entry.target.id}"]`);
        if (active) active.classList.add('active');
      }
    });
  }, { rootMargin: '-20% 0px -70% 0px' });

  sections.forEach(s => sectionObserver.observe(s));
}
