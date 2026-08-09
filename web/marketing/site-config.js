/*
 * Public content slots. Keep empty values empty until the destination is
 * approved. The page renders honest placeholders instead of broken links or
 * invented material.
 */
window.HELMION_SITE_CONFIG = Object.freeze({
  videos: {
    'desktop-overview': {
      src: '/media/helmian-desktop-overview.mp4',
      poster: '/media/helmian-desktop-overview.jpg',
      caption: 'A five-minute walkthrough of Helmian Desktop: projects, Console, Guard Feed, integrations, and reviewable work.',
    },
    'guard-review': {
      src: '/media/helmian-guard-review.mp4',
      poster: '/media/helmian-guard-review.jpg',
      caption: 'Helmian Guard surfaces risky web instructions and sends reviewable evidence into the Guard Feed.',
    },
    'project-flow': {
      src: '/media/helmian-project-flow.mp4',
      poster: '/media/helmian-project-flow.jpg',
      caption: 'Four AI providers — Claude, ChatGPT, Grok, and Gemini — building a real interactive site in parallel, each claiming its own slice of work.',
    },
  },
  links: {
    'product-material': {
      href: 'https://github.com/helmianlabs/helmian',
      label: 'View on GitHub',
    },
    contact: {
      href: 'mailto:helmianlabs@gmail.com',
      label: 'Contact',
    },
  },
});
