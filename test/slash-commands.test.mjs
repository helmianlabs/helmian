import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commandNameFromRelPath,
  discoverCommands,
  expandCommand,
  formatCommandList,
  parseBoolean,
  parseFrontmatter,
  parseSlashInput,
  projectCommandsDir,
  resolveCommand,
  serializeRegistry,
  splitArguments,
  toList,
  userCommandsDir,
} from '../src/agent/commands.mjs';

// --- frontmatter -----------------------------------------------------------

test('frontmatter parses the documented fields and strips them from the body', () => {
  const { meta, body, frontmatterPresent } = parseFrontmatter(
    '---\n'
    + 'description: Deploy the app\n'
    + 'argument-hint: [env] [tag]\n'
    + 'allowed-tools: read_file, list_dir\n'
    + 'arguments: [issue, branch]\n'
    + 'disable-model-invocation: true\n'
    + '---\n'
    + 'Deploy to $0.\n',
  );
  assert.equal(frontmatterPresent, true);
  assert.equal(meta.description, 'Deploy the app');
  assert.equal(meta['argument-hint'], '[env] [tag]');
  assert.deepEqual(toList(meta['allowed-tools']), ['read_file', 'list_dir']);
  assert.deepEqual(meta.arguments, ['issue', 'branch']);
  assert.equal(body, 'Deploy to $0.\n');
});

test('frontmatter accepts YAML block lists', () => {
  const { meta } = parseFrontmatter(
    '---\nallowed-tools:\n  - read_file\n  - search_text\n---\nbody\n',
  );
  assert.deepEqual(meta['allowed-tools'], ['read_file', 'search_text']);
});

test('booleans accept yes/no/on/off/1/0 in any case, per the spec', () => {
  for (const truthy of ['true', 'TRUE', 'yes', 'Yes', 'on', 'ON', '1']) {
    assert.equal(parseBoolean(truthy, false), true, `${truthy} should be true`);
  }
  for (const falsy of ['false', 'No', 'off', '0']) {
    assert.equal(parseBoolean(falsy, true), false, `${falsy} should be false`);
  }
  // Anything unrecognized keeps the default rather than silently flipping.
  assert.equal(parseBoolean('maybe', true), true);
  assert.equal(parseBoolean(undefined, false), false);
});

test('unterminated frontmatter keeps the body instead of eating the file', () => {
  const { meta, body, warnings } = parseFrontmatter('---\ndescription: oops\nno closing fence\n');
  assert.deepEqual(meta, {});
  assert.match(body, /no closing fence/);
  assert.equal(warnings.length, 1);
});

test('a file with no frontmatter is all body', () => {
  const { meta, body, frontmatterPresent } = parseFrontmatter('just instructions\n');
  assert.deepEqual(meta, {});
  assert.equal(frontmatterPresent, false);
  assert.equal(body, 'just instructions\n');
});

// --- argument splitting ----------------------------------------------------

test('arguments split shell-style so a quoted phrase stays one argument', () => {
  // Spec: `/my-skill "hello world" second` makes $0 = hello world, $1 = second.
  assert.deepEqual(splitArguments('"hello world" second'), ['hello world', 'second']);
  assert.deepEqual(splitArguments("'single quoted' b"), ['single quoted', 'b']);
  assert.deepEqual(splitArguments('  a   b  '), ['a', 'b']);
  assert.deepEqual(splitArguments(''), []);
});

test('an unterminated quote yields the rest of the line, not an exception', () => {
  assert.deepEqual(splitArguments('"never closed'), ['never closed']);
});

// --- expansion -------------------------------------------------------------

test('$ARGUMENTS expands to the full argument string as typed', () => {
  assert.equal(
    expandCommand('Fix issue $ARGUMENTS now.', '123 urgent'),
    'Fix issue 123 urgent now.',
  );
});

test('$N is 0-based: $0 is the first argument and $1 the second', () => {
  // Quoted spec: "$N | Shorthand for $ARGUMENTS[N], such as $0 for the first
  // argument or $1 for the second."
  assert.equal(
    expandCommand('Migrate $0 from $1 to $2. $ARGUMENTS', 'SearchBar React Vue'),
    'Migrate SearchBar from React to Vue. SearchBar React Vue',
  );
});

test('$ARGUMENTS[N] indexes the same 0-based positions', () => {
  assert.equal(
    expandCommand('$ARGUMENTS[0]/$ARGUMENTS[2] $ARGUMENTS', 'a b c'),
    'a/c a b c',
  );
});

test('an indexed placeholder with no matching argument stays unchanged', () => {
  // Spec: "$2 when only one argument was passed, stays in the content unchanged."
  assert.equal(expandCommand('one=$0 two=$2 $ARGUMENTS', 'solo'), 'one=solo two=$2 solo');
});

test('named arguments map to positions in declaration order', () => {
  const out = expandCommand(
    'Fix $issue on branch $branch. $ARGUMENTS',
    '42 hotfix',
    { argumentNames: ['issue', 'branch'] },
  );
  assert.equal(out, 'Fix 42 on branch hotfix. 42 hotfix');
});

test('a named placeholder with no matching argument becomes an empty string', () => {
  const out = expandCommand(
    '[$issue][$branch]$ARGUMENTS',
    '42',
    { argumentNames: ['issue', 'branch'] },
  );
  assert.equal(out, '[42][]42');
});

test('an undeclared $word is left completely alone', () => {
  assert.equal(expandCommand('cost $total today $ARGUMENTS', 'x'), 'cost $total today x');
});

test('a single backslash escapes the token and is consumed', () => {
  // Spec: "To include a literal $ before a digit … escape it with a backslash: \$1.00"
  assert.equal(expandCommand('price \\$1.00 $ARGUMENTS', 'a b'), 'price $1.00 a b');
});

test('an ESCAPED $ARGUMENTS does not count as present, so the tail is still appended', () => {
  // The spec does not say what happens when the only $ARGUMENTS in the body is
  // escaped. Ruling: an escaped token is literal prose, so the placeholder is
  // genuinely absent and the documented "ARGUMENTS: <value>" tail applies. The
  // alternative silently drops what the user typed, which is the worse failure.
  assert.equal(
    expandCommand('\\$ARGUMENTS literal $0', 'a'),
    '$ARGUMENTS literal a\n\nARGUMENTS: a',
  );
});

test('a doubled backslash leaves both slashes AND still expands', () => {
  // Spec: "A doubled backslash such as \\$1 leaves both backslashes in place,
  // and $1 still expands to the argument value."
  assert.equal(expandCommand('\\\\$1 $ARGUMENTS', 'a b'), '\\\\b a b');
});

test('arguments are appended when the body never mentions $ARGUMENTS', () => {
  // Spec: "If $ARGUMENTS is not present in the content, arguments are appended
  // as ARGUMENTS: <value>."
  assert.equal(
    expandCommand('Run the audit.', 'src/agent'),
    'Run the audit.\n\nARGUMENTS: src/agent',
  );
});

test('no arguments means no appended tail', () => {
  assert.equal(expandCommand('Run the audit.\n', ''), 'Run the audit.\n');
});

// --- name derivation + parsing --------------------------------------------

test('a top-level file becomes a bare command name', () => {
  assert.deepEqual(commandNameFromRelPath('deploy.md'), {
    base: 'deploy', namespace: null, name: 'deploy',
  });
});

test('a subdirectory namespaces the command with a colon', () => {
  assert.deepEqual(commandNameFromRelPath('frontend/component.md'), {
    base: 'component', namespace: 'frontend', name: 'frontend:component',
  });
  assert.deepEqual(commandNameFromRelPath('apps/web/deploy.md'), {
    base: 'deploy', namespace: 'apps/web', name: 'apps/web:deploy',
  });
});

test('parseSlashInput separates the name from the raw argument string', () => {
  assert.deepEqual(parseSlashInput('/deploy staging v2'), { name: 'deploy', rawArgs: 'staging v2' });
  assert.deepEqual(parseSlashInput('/frontend:component  Button'), {
    name: 'frontend:component', rawArgs: 'Button',
  });
  assert.deepEqual(parseSlashInput('/solo'), { name: 'solo', rawArgs: '' });
  assert.equal(parseSlashInput('not a command'), null);
  assert.equal(parseSlashInput('/'), null);
});

// --- discovery -------------------------------------------------------------

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'helmion-cmd-'));
  const workspace = join(dir, 'workspace');
  const home = join(dir, 'home');
  await mkdir(workspace, { recursive: true });
  await mkdir(home, { recursive: true });
  return { dir, workspace, home };
}

async function writeCommand(root, relPath, contents) {
  const full = join(root, relPath);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, contents);
  return full;
}

test('discovery finds project and user commands, including namespaced ones', async (t) => {
  const { dir, workspace, home } = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeCommand(
    projectCommandsDir(workspace),
    'deploy.md',
    '---\ndescription: Ship the current branch\nargument-hint: [env]\n---\nDeploy to $0.\n',
  );
  await writeCommand(
    projectCommandsDir(workspace),
    'frontend/component.md',
    '---\ndescription: Scaffold a component\n---\nCreate component $ARGUMENTS.\n',
  );
  await writeCommand(
    userCommandsDir(home),
    'standup.md',
    '---\ndescription: Write my standup note\n---\nSummarize $ARGUMENTS.\n',
  );

  const registry = await discoverCommands({ workspace, home, builtins: ['help', 'exit'] });

  assert.deepEqual(
    registry.list.map((c) => c.name).sort(),
    ['deploy', 'frontend:component', 'standup'],
  );
  assert.equal(registry.commands.get('deploy').description, 'Ship the current branch');
  assert.equal(registry.commands.get('deploy').argumentHint, '[env]');
  assert.equal(registry.commands.get('deploy').source, 'project');
  assert.equal(registry.commands.get('standup').source, 'user');
  assert.equal(registry.commands.get('frontend:component').namespace, 'frontend');
});

test('a bare name resolves to its namespaced command when nothing else claims it', async (t) => {
  const { dir, workspace, home } = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeCommand(projectCommandsDir(workspace), 'frontend/component.md', 'Build $ARGUMENTS\n');

  const registry = await discoverCommands({ workspace, home });
  assert.equal(resolveCommand(registry, 'frontend:component').base, 'component');
  assert.equal(resolveCommand(registry, 'component').name, 'frontend:component');
  assert.equal(resolveCommand(registry, 'nope'), null);
});

test('a user command overrides a project command of the same name, and says so', async (t) => {
  const { dir, workspace, home } = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeCommand(projectCommandsDir(workspace), 'deploy.md', 'PROJECT VERSION\n');
  await writeCommand(userCommandsDir(home), 'deploy.md', 'USER VERSION\n');

  const registry = await discoverCommands({ workspace, home });
  assert.match(registry.commands.get('deploy').body, /USER VERSION/);
  assert.equal(registry.overridden.length, 1);
  assert.equal(registry.overridden[0].name, 'deploy');
});

test('a user file CANNOT shadow a built-in; it is refused and reported', async (t) => {
  const { dir, workspace, home } = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeCommand(userCommandsDir(home), 'exit.md', 'this must never hijack /exit\n');
  await writeCommand(projectCommandsDir(workspace), 'ok.md', 'fine\n');

  const registry = await discoverCommands({
    workspace, home, builtins: ['exit', 'help', 'clear'],
  });

  assert.equal(registry.commands.has('exit'), false, '/exit must stay built-in');
  assert.equal(resolveCommand(registry, 'exit'), null);
  assert.equal(registry.shadowedBuiltins.length, 1);
  assert.equal(registry.shadowedBuiltins[0].name, 'exit');
  // And the refusal is visible to the human, not just in a return value.
  assert.match(formatCommandList(registry), /IGNORED — built-in commands cannot be overridden/);
});

test('/help output lists every discovered command with its description', async (t) => {
  const { dir, workspace, home } = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeCommand(
    projectCommandsDir(workspace),
    'deploy.md',
    '---\ndescription: Ship the current branch\nargument-hint: [env]\n---\nbody\n',
  );
  await writeCommand(
    projectCommandsDir(workspace),
    'db/migrate.md',
    '---\ndescription: Apply pending migrations\n---\nbody\n',
  );

  const listing = formatCommandList(await discoverCommands({ workspace, home }));
  assert.match(listing, /\/deploy \[env\]\s+Ship the current branch\s+\[project\]/);
  assert.match(listing, /\/db:migrate\s+Apply pending migrations\s+\[project\]/);
});

test('a command with no description falls back to its first paragraph', async (t) => {
  const { dir, workspace, home } = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeCommand(projectCommandsDir(workspace), 'notes.md', 'Summarize the session notes.\n\nMore detail here.\n');
  const registry = await discoverCommands({ workspace, home });
  assert.equal(registry.commands.get('notes').description, 'Summarize the session notes.');
});

test('user-invocable false hides a command from the listing but keeps it loadable', async (t) => {
  const { dir, workspace, home } = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeCommand(
    projectCommandsDir(workspace),
    'internal.md',
    '---\ndescription: background knowledge\nuser-invocable: false\n---\nbody\n',
  );
  const registry = await discoverCommands({ workspace, home });
  assert.equal(registry.commands.has('internal'), true);
  assert.doesNotMatch(formatCommandList(registry), /\/internal/);
});

test('missing command directories are not an error', async (t) => {
  const { dir, workspace, home } = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registry = await discoverCommands({ workspace, home });
  assert.equal(registry.list.length, 0);
  assert.equal(registry.errors.length, 0);
  assert.match(formatCommandList(registry), /\(none/);
});

test('the serialized registry carries no command bodies to the desktop', async (t) => {
  const { dir, workspace, home } = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeCommand(
    projectCommandsDir(workspace),
    'deploy.md',
    '---\ndescription: Ship it\n---\nSECRET BODY TEXT\n',
  );
  const payload = serializeRegistry(await discoverCommands({ workspace, home }));
  assert.equal(payload.commands.length, 1);
  assert.equal(payload.commands[0].description, 'Ship it');
  assert.equal('body' in payload.commands[0], false);
  assert.doesNotMatch(JSON.stringify(payload), /SECRET BODY TEXT/);
});

// --- end-to-end: file on disk → expanded prompt ----------------------------

test('a real file on disk expands end to end through discovery', async (t) => {
  const { dir, workspace, home } = await fixture();
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeCommand(
    projectCommandsDir(workspace),
    'review/pr.md',
    '---\n'
    + 'description: Review a pull request\n'
    + 'argument-hint: [pr-number] [focus]\n'
    + 'arguments: [pr, focus]\n'
    + '---\n'
    + 'Review PR #$pr focusing on $focus.\nRaw: $ARGUMENTS\n',
  );

  const registry = await discoverCommands({ workspace, home });
  const cmd = resolveCommand(registry, 'review:pr');
  const expanded = expandCommand(cmd.body, '412 "error handling"', {
    argumentNames: cmd.argumentNames,
  });
  assert.equal(expanded, 'Review PR #412 focusing on error handling.\nRaw: 412 "error handling"\n');
});
