#!/usr/bin/env node
// Upsert the Cora ElevenLabs agent from cora/elevenlabs/{agent,tools}.json.
// Usage: ELEVENLABS_API_KEY=... node cora/elevenlabs/scripts/sync-elevenlabs-agent.mjs [--dry-run]
// - Tools are upserted by name as standalone client tools (/v1/convai/tools).
// - Agent is created if agent.json has no agent_id, else PATCHed. New agent_id is written back.
// - Never prints the API key. Never deletes anything. Generates no speech.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.elevenlabs.io";
const KEY = process.env.ELEVENLABS_API_KEY;
const DRY = process.argv.includes("--dry-run");
if (!KEY && !DRY) { console.error("ELEVENLABS_API_KEY not set"); process.exit(1); }

const agentPath = path.join(ROOT, "agent.json");
const cfg = JSON.parse(fs.readFileSync(agentPath, "utf8"));
const { tools } = JSON.parse(fs.readFileSync(path.join(ROOT, cfg.tools_file), "utf8"));
const prompt = fs.readFileSync(path.join(ROOT, cfg.prompt_file), "utf8");

async function api(method, p, body) {
  const r = await fetch(API + p, {
    method,
    headers: { "xi-api-key": KEY, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status}: ${text.slice(0, 800)}`);
  return text ? JSON.parse(text) : {};
}

function toolConfig(t) {
  return {
    tool_config: {
      type: "client",
      name: t.name,
      description: t.description.slice(0, 1000),
      parameters: t.parameters,
      expects_response: true,
      response_timeout_secs: cfg.client_tool_response_timeout_secs ?? 20,
    },
  };
}

async function listTools() {
  const out = []; let cursor;
  do {
    const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const d = await api("GET", `/v1/convai/tools${q}`);
    out.push(...(d.tools ?? []));
    cursor = d.has_more ? d.next_cursor : null;
  } while (cursor);
  return out;
}

async function main() {
  if (DRY) { console.log(`dry-run: ${tools.length} tools, voice ${cfg.voice.voice_id}, llm ${cfg.llm.model}`); return; }
  const existing = new Map((await listTools()).map((t) => [t.tool_config?.name, t.id]));
  const toolIds = [];
  for (const t of tools) {
    const id = existing.get(t.name);
    if (id) { await api("PATCH", `/v1/convai/tools/${id}`, toolConfig(t)); toolIds.push(id); }
    else { const d = await api("POST", "/v1/convai/tools", toolConfig(t)); toolIds.push(d.id); }
    process.stdout.write(".");
  }
  console.log(`\n${toolIds.length} tools upserted`);

  const body = {
    name: cfg.name,
    tags: ["cora", cfg.surface],
    conversation_config: {
      agent: {
        first_message: cfg.first_message,
        language: cfg.language,
        dynamic_variables: { dynamic_variable_placeholders: cfg.dynamic_variables },
        prompt: { prompt, llm: cfg.llm.model, temperature: cfg.llm.temperature, tool_ids: toolIds },
      },
      tts: { voice_id: cfg.voice.voice_id, model_id: cfg.voice.model_id },
    },
  };
  let agentId = cfg.agent_id;
  if (agentId) { await api("PATCH", `/v1/convai/agents/${agentId}`, body); console.log(`updated agent ${agentId}`); }
  else {
    const d = await api("POST", "/v1/convai/agents/create", body);
    agentId = d.agent_id;
    cfg.agent_id = agentId;
    fs.writeFileSync(agentPath, JSON.stringify(cfg, null, 2) + "\n");
    console.log(`created agent ${agentId} (written to agent.json)`);
  }
}
main().catch((e) => { console.error(String(e.message).replaceAll(KEY ?? "\u0000", "***")); process.exit(1); });
