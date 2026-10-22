// Avatars for chats and agents. Two looks: playful characters, or simple
// letter icons for people who want plain names. Pure, so it is unit tested.
export const CHARACTERS = Object.freeze([
  ['fox', '🦊', 'Fox'], ['panda', '🐼', 'Panda'], ['octo', '🐙', 'Octopus'], ['unicorn', '🦄', 'Unicorn'],
  ['frog', '🐸', 'Frog'], ['robot', '🤖', 'Robot'], ['alien', '👾', 'Pixel'], ['cat', '🐱', 'Cat'],
  ['pup', '🐶', 'Pup'], ['owl', '🦉', 'Owl'], ['bee', '🐝', 'Bee'], ['penguin', '🐧', 'Penguin'],
]);
export const COLORS = Object.freeze(['#38bdf8', '#a78bfa', '#f472b6', '#fb923c', '#facc15', '#4ade80', '#2dd4bf', '#94a3b8']);

const hash = (s) => [...String(s ?? '')].reduce((a, c) => (a * 31 + c.codePointAt(0)) >>> 0, 7);

export function initialOf(title) {
  const t = String(title ?? '').trim().replace(/^[#@]+/, '');
  const ch = [...t].find((c) => /\p{L}|\p{N}/u.test(c));
  return ch ? ch.toUpperCase() : '#';
}

// Saved choice -> what to draw. Unknown or missing choices fall back to a simple icon,
// coloured from the name so it stays the same on every visit.
export function avatarFor(choice, title) {
  if (choice?.k === 'char') {
    const c = CHARACTERS.find(([id]) => id === choice.id);
    if (c) return { kind: 'char', glyph: c[1], label: c[2] };
  }
  const color = choice?.k === 'plain' && COLORS[choice.c] ? COLORS[choice.c] : COLORS[hash(title) % COLORS.length];
  return { kind: 'plain', glyph: initialOf(title), label: String(title ?? '').trim() || 'Chat', color };
}

// A good first pick for a new chat: a character in playful mode, a plain icon otherwise.
export function defaultChoice(title, mode = 'playful') {
  if (mode === 'plain') return { k: 'plain', c: hash(title) % COLORS.length };
  return { k: 'char', id: CHARACTERS[hash(title) % CHARACTERS.length][0] };
}

export function sanitizeChoice(v) {
  if (v?.k === 'char' && CHARACTERS.some(([id]) => id === v.id)) return { k: 'char', id: v.id };
  if (v?.k === 'plain' && Number.isInteger(v.c) && v.c >= 0 && v.c < COLORS.length) return { k: 'plain', c: v.c };
  return null;
}
