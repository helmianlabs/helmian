// Pure state for the /join page.
export const INVITE_TOKEN = /^hinv_[A-Za-z0-9_-]{32,64}$/;
const MESSAGES = {
  invalid: ['This invite link is not valid', 'Check that you copied the whole link, or ask for a new one.'],
  invite_expired: ['This invite link has expired', 'Ask the person who invited you for a new link.'],
  already_in_organization: ['You already belong to a team', 'This account is already part of another Helmian organization. Sign in with a different account to join.'],
  unavailable: ['Helmian is busy right now', 'Please try the link again in a minute.'],
};
const msg = (key) => ({ state: 'problem', title: MESSAGES[key][0], text: MESSAGES[key][1] });
export function joinModel({ token = '', error = null, preview = null, status = null } = {}) {
  if (error) return msg(MESSAGES[error] ? error : 'invalid');
  if (!INVITE_TOKEN.test(token)) return msg('invalid');
  if (status == null) return { state: 'check' };
  if (status === 410) return msg('invite_expired');
  if (status === 400) return msg('invalid');
  if (status !== 200 || !preview?.organization) return msg('unavailable');
  const base = `/admin/auth/join?token=${encodeURIComponent(token)}`;
  return { state: 'ready', organization: String(preview.organization), signupUrl: base, signinUrl: `${base}&mode=signin` };
}
