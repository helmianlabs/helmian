import { randomUUID } from 'node:crypto';
import { requireActiveTenantMembership, withTenantTransaction } from '../core/tenant-context.mjs';

const COMMANDS = new Set(['workspace_context', 'list_agents', 'open_project', 'run_project_task', 'start_project_preview', 'stop_project_preview']);
const MAX_ARGUMENTS = 4000;

function context(actor) {
  if (!actor?.tenantId || !actor.subject || !actor.role || !actor.sessionId || !actor.requestId) throw new Error('verified Organization membership is required');
  return { tenantId: actor.tenantId, actorSubject: actor.subject, actorRole: actor.role, sessionId: actor.sessionId, requestId: actor.requestId };
}

function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('console command must be an object'), { status: 400 });
  const commandName = String(input.commandName ?? '').trim().toLowerCase();
  const reason = String(input.reason ?? '').trim().slice(0, 500);
  const idempotencyKey = String(input.idempotencyKey ?? '').trim();
  const argumentsValue = input.arguments ?? {};
  if (!COMMANDS.has(commandName) || !reason || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(idempotencyKey) || !argumentsValue || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue) || JSON.stringify(argumentsValue).length > MAX_ARGUMENTS) throw Object.assign(new Error('console command intent is invalid'), { status: 400 });
  return { commandName, reason, idempotencyKey, arguments: argumentsValue };
}

function row(item, replayed = false) {
  return { commandName: item.command_name, arguments: item.arguments, reason: item.reason, status: item.status, receiptId: item.receipt_id, idempotencyKey: item.idempotency_key, execution: 'not_performed', createdAt: item.created_at, replayed };
}

const SELECT = 'command_name, arguments, reason, status, receipt_id, idempotency_key, created_at';

export function createConsoleCommandRepository(pool) {
  return Object.freeze({
    async append(actor, input) {
      const active = context(actor);
      const command = normalize(input);
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const receiptId = randomUUID();
        const inserted = await client.query(`insert into helmion.console_command_intents (tenant_id, actor_subject, command_name, arguments, reason, receipt_id, idempotency_key) values ($1,$2,$3,$4::jsonb,$5,$6,$7) on conflict (tenant_id,idempotency_key) do nothing returning ${SELECT}`, [active.tenantId, active.actorSubject, command.commandName, JSON.stringify(command.arguments), command.reason, receiptId, command.idempotencyKey]);
        if (inserted.rowCount === 1) return { durable: true, command: row(inserted.rows[0]), source: 'tenant_console_command_intents' };
        const replay = await client.query(`select ${SELECT} from helmion.console_command_intents where tenant_id=$1 and idempotency_key=$2`, [active.tenantId, command.idempotencyKey]);
        if (replay.rowCount !== 1) throw new Error('console command receipt was not durable');
        return { durable: true, command: row(replay.rows[0], true), source: 'tenant_console_command_intents' };
      });
    },
    async list(actor, limit = 50) {
      const active = context(actor);
      const bounded = Math.min(Math.max(Number(limit) || 50, 1), 100);
      return withTenantTransaction(pool, active, async (client) => {
        await requireActiveTenantMembership(client, active);
        const result = await client.query(`select ${SELECT} from helmion.console_command_intents where tenant_id=$1 order by created_at desc, id desc limit $2`, [active.tenantId, bounded]);
        return { commands: result.rows.map((item) => row(item)), source: 'tenant_console_command_intents', execution: 'not_performed' };
      });
    },
  });
}

export { normalize as normalizeConsoleCommand };
