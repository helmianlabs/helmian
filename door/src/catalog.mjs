// The door's scope policy: which backend owns a tool and which door scope a
// caller must hold to see/call it. Mirrors each backend's own internal gating
// (memory server: save/move/add_rule demand memory.write; hands server:
// mutating tools demand hands.act, and hands.act satisfies read checks).
// Unknown tools discovered in a backend catalog fall back to that backend's
// strict scope (memory.write / hands.act) — fail closed, never open.

export const TOOL_POLICY = Object.freeze({
  // — memory backend (Helmian Scribe) —
  search_memory: { backend: 'memory', scope: 'memory.read' },
  read_memory: { backend: 'memory', scope: 'memory.read' },
  list_unsorted: { backend: 'memory', scope: 'memory.read' },
  explain_filing: { backend: 'memory', scope: 'memory.read' },
  save_memory: { backend: 'memory', scope: 'memory.write' },
  move_memory: { backend: 'memory', scope: 'memory.write' },
  add_rule: { backend: 'memory', scope: 'memory.write' },
  // — hands backend —
  hands_status: { backend: 'hands', scope: 'hands.read' },
  list_files: { backend: 'hands', scope: 'hands.read' },
  read_file: { backend: 'hands', scope: 'hands.read' },
  search_files: { backend: 'hands', scope: 'hands.read' },
  ollama_generate: { backend: 'hands', scope: 'hands.read' },
  run_powershell: { backend: 'hands', scope: 'hands.act' },
  phone_look: { backend: 'hands', scope: 'hands.read' },
  run_phone: { backend: 'hands', scope: 'hands.act' },
  open_url: { backend: 'hands', scope: 'hands.act' },
  write_file: { backend: 'hands', scope: 'hands.act' },
  move_file: { backend: 'hands', scope: 'hands.act' },
  copy_file: { backend: 'hands', scope: 'hands.act' },
  delete_file: { backend: 'hands', scope: 'hands.act' },
  make_dir: { backend: 'hands', scope: 'hands.act' },
  edit_file: { backend: 'hands', scope: 'hands.act' },
  resume_action: { backend: 'hands', scope: 'hands.act' },
});

export function fallbackPolicy(backend) {
  return { backend, scope: backend === 'memory' ? 'memory.write' : 'hands.act' };
}

export function scopeSatisfied(have, need) {
  if (!Array.isArray(have)) return false;
  if (have.includes(need)) return true;
  // Same implication the hands backend itself applies.
  if (need === 'hands.read' && have.includes('hands.act')) return true;
  return false;
}
