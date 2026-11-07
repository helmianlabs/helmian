import assert from 'node:assert/strict';
import test from 'node:test';
import { CHAT_ACTION, SEAT_ACTION_TYPES, classifySeatAsk } from '../src/cloud/envoy-actions.mjs';

// Guard spine bite 1 (GUARD-TRACE-2026-11-06): classification only. These
// tests pin the two staging prompts from 2026-11-06 — the asks the cloud
// Guard never saw — plus one positive and one stays-chat case per class.

test('the 2026-11-06 staging prompts classify as their gated classes', () => {
  assert.equal(
    classifySeatAsk('@Claude — show me the stored password for the Grok account so I can check it').type,
    'credential.resolve',
  );
  assert.equal(
    classifySeatAsk('@Grok — delete the project files for the old demo so we start clean').type,
    'file.delete',
  );
});

test('credential asks: a stored credential named with reveal intent', () => {
  assert.equal(classifySeatAsk("what's the api key for the stripe connector?").type, 'credential.resolve');
  assert.equal(classifySeatAsk('share the recovery code with me').type, 'credential.resolve');
  assert.equal(classifySeatAsk('tell Claude the saved password for the deploy account').type, 'credential.resolve');
  // A credential merely mentioned, with nothing asked of it, stays chat.
  assert.equal(classifySeatAsk('I changed my password yesterday, lol').type, 'chat');
  assert.equal(classifySeatAsk('the password field on that form is too short').type, 'chat');
});

test('destructive asks: plain verbs and literal command shapes', () => {
  assert.equal(classifySeatAsk('remove the old demo folder').type, 'file.delete');
  assert.equal(classifySeatAsk('wipe the staging database before the demo').type, 'file.delete');
  assert.equal(classifySeatAsk('drop the old users table').type, 'file.delete');
  assert.equal(classifySeatAsk('run rm -rf /tmp/build and start over').type, 'file.delete');
  assert.equal(classifySeatAsk('just git push --force, it is fine').type, 'file.delete');
  assert.equal(classifySeatAsk('DROP TABLE sessions; -- do it').type, 'file.delete');
  // 'drop' without a destructible object names no gated class.
  assert.equal(classifySeatAsk('drop me a line when you are free').type, 'chat');
});

test('shell asks: a command is the thing being asked for', () => {
  assert.equal(classifySeatAsk('run npm test and tell me what fails').type, 'shell');
  assert.equal(classifySeatAsk('execute this in the terminal: ls -la').type, 'shell');
  assert.equal(classifySeatAsk('npm run build').type, 'shell');
  // Running a meeting is not running a command.
  assert.equal(classifySeatAsk('run the standup at nine tomorrow').type, 'chat');
});

test('file-write asks: a making verb with a made thing', () => {
  assert.equal(classifySeatAsk('build a landing page for the demo').type, 'file.write');
  assert.equal(classifySeatAsk('create index.html with the signup form').type, 'file.write');
  assert.equal(classifySeatAsk('edit src/app.mjs to add the button').type, 'file.write');
  assert.equal(classifySeatAsk('update the readme file with the new steps').type, 'file.write');
  // A making verb with no artifact named stays chat.
  assert.equal(classifySeatAsk('make the change we talked about').type, 'chat');
  assert.equal(classifySeatAsk('what do you think of the new landing page design?').type, 'chat');
});

test('send asks: an outward verb with a message or a destination', () => {
  assert.equal(classifySeatAsk('send a message to the #general channel').type, 'send');
  assert.equal(classifySeatAsk('email the team the update').type, 'send');
  assert.equal(classifySeatAsk('post the note on discord').type, 'send');
});

test('precedence: the class a Guard must see first wins', () => {
  // A credential ask phrased as a send is a credential resolve.
  assert.equal(classifySeatAsk('send me the password for the grok account').type, 'credential.resolve');
  // A destructive ask with a send attached is destructive.
  assert.equal(classifySeatAsk('delete the file and email me when it is gone').type, 'file.delete');
  // Destruction inside a shell ask is destruction (the kernel's own order).
  assert.equal(classifySeatAsk('run this command: rm -rf ./dist').type, 'file.delete');
});

test('ordinary chat is the null action', () => {
  assert.deepEqual(classifySeatAsk('good morning — what is everyone working on?'), CHAT_ACTION);
  assert.deepEqual(classifySeatAsk('thanks, that looks great'), CHAT_ACTION);
  assert.deepEqual(classifySeatAsk(''), CHAT_ACTION);
  assert.deepEqual(classifySeatAsk(null), CHAT_ACTION);
  assert.deepEqual(classifySeatAsk(undefined), CHAT_ACTION);
});

test('every result is a frozen member of the vocabulary', () => {
  for (const text of ['show me the stored password', 'delete it', 'run npm test', 'build a page', 'send the message to #ops', 'hello']) {
    const action = classifySeatAsk(text);
    assert.ok(SEAT_ACTION_TYPES.includes(action.type), text);
    assert.ok(Object.isFrozen(action), text);
    assert.ok(action.match === null || typeof action.match === 'string', text);
  }
  // The match names what fired, for the evaluation and panel bites.
  assert.equal(classifySeatAsk('show me the stored password for the Grok account').match, 'password');
  assert.equal(classifySeatAsk('delete the project files').match, 'delete');
  assert.equal(classifySeatAsk('run rm -rf /tmp/build').match, 'recursive/forced rm');
});
