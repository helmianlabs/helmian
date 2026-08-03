export const THEMES = Object.freeze([
  'midnight',
  'black',
  'white',
  'paper',
  'ocean',
  'glass',
  'warm',
  'forest',
]);

/** Browser chrome / status-bar colors for each Herald theme. */
export const THEME_COLORS = Object.freeze({
  midnight: '#0b1018',
  black: '#050505',
  white: '#f4f6f8',
  paper: '#f7f3ea',
  ocean: '#07111d',
  glass: '#08080c',
  warm: '#17100b',
  forest: '#08100f',
});

export const DRAWERS = Object.freeze([
  'projects',
  'browser',
  'canvas',
  'preview',
  'create',
  'integrations',
  'guard',
  'history',
  'help',
  'troubleshooting',
]);

export function normalizeTheme(value) {
  return THEMES.includes(value) ? value : 'midnight';
}

export function themeChromeColor(value) {
  return THEME_COLORS[normalizeTheme(value)] ?? THEME_COLORS.midnight;
}

export function normalizeDrawer(value) {
  return DRAWERS.includes(value) ? value : null;
}

export function normalizeMobilePane(value) {
  return value === 'conversation' ? 'conversation' : 'team';
}

export function connectionRequirement(action, provider) {
  if (action === 'provider') {
    const name = provider === 'Slack' || provider === 'Discord' ? provider : 'This provider';
    return `${name} is not connected. A verified connection is required; account and credential setup are not available in this build.`;
  }
  const messages = {
    send: 'Connect Helmian Desktop to send. Your draft is still saved locally.',
    project: 'A live project endpoint is required to choose or create a project.',
    create: 'Open a project and connect Helmian Desktop before creating this artifact.',
  };
  return messages[action] ?? 'A live connection is required for this action.';
}
