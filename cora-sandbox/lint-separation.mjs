// Separation lint: the sandbox must never reference other tenant product hosts, keys or tenants.
// Pattern is assembled from parts so this file does not contain the literal name.
const PARTS = ['dair', 'yforge'];
export const FORBIDDEN = Object.freeze([new RegExp(PARTS.join(''), 'i')]);

// files: [{ path, content }] -> [{ path, line, match }]
export function lintSeparation(files) {
  const violations = [];
  for (const { path, content } of files) {
    const lines = String(content).split('\n');
    lines.forEach((text, index) => {
      for (const re of FORBIDDEN) {
        const found = text.match(re);
        if (found) violations.push({ path, line: index + 1, match: found[0] });
      }
    });
  }
  return violations;
}
