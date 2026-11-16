// Helm, the answerer (fix programme bite H3, DESIGN 3.3): the
// presence law made code. Helm is the answerer of last resort in
// every channel — roster-present by default, never a vendor seat,
// never in a due set (envoy-agents.mjs, bite H1). Whether Helm
// answers a given message is the pure helmDue decision there;
// this module is the answering itself: the post, the mark, and
// the miss filing for the questions Helm could not answer.
//
// The answer, until bite H4 composes real ones from records, is
// the honest availability line and nothing else: Helm says no
// seat is connected to answer, and the question files to the
// guide's miss queue (helm-kb.mjs's fileHelmKbMiss — the one
// queue DESIGN 3.5 names for guide misses and unanswered
// questions alike), where a person grows the guide and the
// records from real unanswered questions. Helm never invents an
// answer: not for the empty-due case the design names, and not
// where Helm is the named or @all answerer either — the same
// honesty governs every case until H4 lands.
//
// The posting is a stored agent message under agent:helm (the
// subject bite H1 made real and H2 gave the guide's mouth), so
// it renders as Helm, persists like any reply, is spoken in
// Helm's voice bm_george by the existing voice controller, and
// is filtered out of every routing result by the same role
// exclusions that guard Maestro's lines — it opens no debate
// turn and earns nobody work. Its idempotency key is
// helm:<messageId>: one Helm answer per message, however many
// polls see it.
//
// The mark: a message Helm answered alone (@Helm named) is
// marked metadata.helmOnly on the human message, in the same
// transaction as the answer post, so the two land together or
// not at all. The mesh reads the mark the way it reads the
// guide's and the Librarian's: a marked message is never handed
// to a vendor seat. The 'team' and 'last-resort' answers carry
// no mark — the seats were due, or nobody was; nothing about
// the message's routing needs recording beyond Helm's answer
// itself, which is what later polls read to stay silent.

import { fileHelmKbMiss } from './helm-kb.mjs';

export const HELM_SUBJECT = 'agent:helm';
export const HELM_KEY_PREFIX = 'helm:';

// The honest availability line (DESIGN 3.3, verbatim): the only
// answer Helm posts until the grounded composer (bite H4) lands.
export const HELM_AVAILABILITY_LINE = 'No seat is connected to answer that here';

/**
 * The insert spec for one Helm answer, in the shape the mesh's
 * write transaction already posts refusal rows in: the
 * availability line as agent:helm, keyed helm:<messageId>, with
 * the due case and the asker riding in its metadata. The mesh
 * publishes the row only when the insert actually wrote it, so a
 * replayed answer is never announced twice.
 */
export function helmAnswerSpec({ tenantId, channelId, message, due } = {}) {
  return {
    tenantId,
    channelId: String(channelId),
    subject: HELM_SUBJECT,
    kind: 'agent',
    body: HELM_AVAILABILITY_LINE,
    key: `${HELM_KEY_PREFIX}${message.id}`,
    metadata: { helm: { due, forSubject: String(message.authorSubject) } },
  };
}

/**
 * Mark one human message helmOnly, on the mesh write
 * transaction's client: the guide's mark update, one namespace
 * over (coalesce-merge, so the mark lands beside whatever
 * metadata the message already carries and never overwrites it).
 */
export async function markHelmOnlyMessage(client, { tenantId, channelId, messageId, senderSubject } = {}) {
  await client.query(
    `update helmion.envoy_messages
        set metadata = coalesce(metadata, '{}'::jsonb) || $5::jsonb
      where tenant_id=$1 and channel_id=$2 and id=$3 and author_subject=$4`,
    [String(tenantId), String(channelId), messageId, String(senderSubject),
      JSON.stringify({ helmOnly: { answeredBy: 'helm' } })],
  );
}

/**
 * File one question Helm answered with the availability line to
 * the miss queue. The filer is helm-kb.mjs's own: fail-soft by
 * design (the queue's absence never touches anything) and
 * counting repeats on one row. This wrapper adds the tail's
 * discipline on top: it never throws, so a surprise failure is
 * logged loudly by the caller-visible log and changes nothing
 * about the answer that was posted. Returns true when the
 * question was filed.
 */
export async function fileHelmUnansweredQuestion({ pool, tenantId, channelId, senderSubject, question, log = null } = {}) {
  try {
    return await fileHelmKbMiss({ pool, tenantId, channelId, senderSubject, question });
  } catch (error) {
    (log ?? ((...args) => console.error(...args)))(`[envoy-helm] miss filing FAILED for tenant ${tenantId}: ${error?.message ?? error} — the answer stands; the question was not filed.`);
    return false;
  }
}
