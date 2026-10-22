// Read a secret from the terminal without echoing it.
//
// readline's _writeToOutput trick is not reliable: on Windows PowerShell 7 and cmd the
// console still echoed the passphrase. Here the TTY goes into raw mode, so the console
// never echoes, and each typed character is shown as '*'. Piped input (not a TTY) is
// read as one line with nothing echoed.

export function readHidden(prompt, { input = process.stdin, output = process.stdout, mask = '*' } = {}) {
  return new Promise((resolve, reject) => {
    output.write(prompt);
    let value = '';
    const tty = Boolean(input.isTTY && typeof input.setRawMode === 'function');
    const wasRaw = tty ? Boolean(input.isRaw) : false;
    const finish = (err) => {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      if (tty) input.setRawMode(wasRaw);
      input.pause?.();
      output.write('\n');
      if (err) reject(err); else resolve(value);
    };
    const onEnd = () => finish();
    const onData = (chunk) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') { finish(); return; }
        if (ch === '\u0003') { const e = new Error('Cancelled'); e.code = 'ABORT_ERR'; finish(e); return; }
        if (ch === '\u0004' && tty) { finish(); return; }
        if (ch === '\u007f' || ch === '\b') {
          if (value.length) { value = [...value].slice(0, -1).join(''); if (tty && mask) output.write('\b \b'); }
          continue;
        }
        if (ch < ' ') continue; // other control keys (arrows arrive as ESC sequences)
        value += ch;
        if (tty && mask) output.write(mask);
      }
    };
    if (tty) input.setRawMode(true);
    input.setEncoding?.('utf8');
    input.on('data', onData);
    input.on('end', onEnd);
    input.resume?.();
  });
}
