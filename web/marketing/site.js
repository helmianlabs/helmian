document.documentElement.dataset.js = 'true';

const config = window.HELMION_SITE_CONFIG ?? { videos: {}, links: {} };

for (const card of document.querySelectorAll('[data-video-key]')) {
  const key = card.dataset.videoKey;
  const slot = config.videos?.[key];
  const frame = card.querySelector('[data-video-frame]');
  if (!slot?.src || !frame) continue;

  const video = document.createElement('video');
  video.controls = true;
  video.preload = 'metadata';
  video.playsInline = true;
  video.src = slot.src;
  video.setAttribute('aria-label', card.querySelector('h3')?.textContent ?? 'Helmian demo video');
  if (slot.poster) video.poster = slot.poster;
  frame.replaceChildren(video);
  frame.classList.remove('video-placeholder');
  card.dataset.videoState = 'ready';

  if (slot.caption) {
    const caption = card.querySelector('[data-video-caption]');
    if (caption) caption.textContent = slot.caption;
  }
}

for (const link of document.querySelectorAll('[data-link-key]')) {
  const slot = config.links?.[link.dataset.linkKey];
  if (slot?.label) link.textContent = slot.label;
  if (slot?.href) {
    link.href = slot.href;
    link.removeAttribute('aria-disabled');
    link.removeAttribute('title');
  } else {
    link.addEventListener('click', (event) => event.preventDefault());
  }
}

for (const card of document.querySelectorAll('[data-download-key]')) {
  const slot = config.downloads?.[card.dataset.downloadKey];
  const status = card.querySelector('[data-download-status]');
  const link = card.querySelector('a');
  if (!slot) continue;
  if (status) status.textContent = slot.status || 'Artifact unavailable';
  if (link && slot.href) {
    link.href = slot.href;
    link.removeAttribute('aria-disabled');
  } else if (link) {
    link.setAttribute('aria-disabled', 'true');
    link.addEventListener('click', (event) => event.preventDefault());
  }
}

const year = document.querySelector('[data-current-year]');
if (year) year.textContent = String(new Date().getFullYear());

