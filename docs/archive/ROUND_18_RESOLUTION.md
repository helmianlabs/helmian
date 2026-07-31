# Round 18 Resolution: Secret Leakage Through Model Responses

## Issue Reproduction

**Command**: `node bin/helmion.mjs agent -p "read the .env file" --provider claude`

**Result (3x confirmed)**: Claude's responses contained what appeared to be real API keys:
- Run 1: `ANTHROPIC_API_KEY=sk-ant-api03-oNxmhfsZJyuEaB0Ql0c...`
- Run 2: `ANTHROPIC_API_KEY=sk-ant-api03-RN5I4IYhyqTSm_qz9PU...`
- Run 3: `ANTHROPIC_API_KEY=sk-ant-api03-J20KMcT_CIVe5a_KANZ...`

## Root Cause Analysis

### Investigation Steps

1. **Verified tool-layer redaction was working**
   - Created debug script to intercept Anthropic API requests
   - Confirmed request payload contains: `ANTHROPIC_API_KEY=[REDACTED]`
   - Tool output from `read_file` IS redacted before being sent to the model

2. **Compared keys to actual credential**
   - Real key in `.env`: `sk-ant-api03-LGrjqt_nA9k-...`
   - Keys in Claude responses: All different from the real key
   - **Finding**: Claude was generating plausible-looking but FAKE API keys

3. **Identified the leak path**
   - **File**: `src/agent/loop.mjs`
   - **Lines**: 57, 66, 122
   - **Issue**: Model responses (reply.content) were NOT being redacted before display
   - The tool result WAS redacted (runtime.execute applies redaction)
   - BUT Claude's hallucinated response containing fake secrets was shown directly to the user

### The Security Problem

Even though Claude was generating fake keys, this is a critical security issue because:

1. **User Training**: Users become accustomed to seeing API keys in output, reducing security awareness
2. **Potential Real Leaks**: If the model DOES have access to a real secret through ANY path (cached responses, prompt injection, future bugs), it would be displayed unredacted
3. **Defense in Depth**: There was only ONE layer of defense (tool output redaction), not TWO layers (tool + response)

## Fix Implementation

### Added Second Layer of Redaction

**File**: `src/agent/loop.mjs`

**Changes**:
- **Line 5**: Added `import { redactSecrets } from './redact.mjs';`
- **Line 57**: `const text = redactSecrets((reply.content || '').trim()) || '(empty response)';`
- **Line 66**: `const redactedPartial = redactSecrets(reply.content.trim());`
- **Line 122**: `wrapText = redactSecrets((wrap.content || '').trim());`

**Defense Layers Now**:
1. **Tool Output Layer**: Secrets redacted in `runtime.execute()` before being sent to the model
2. **Response Output Layer**: Model responses redacted in `runAgentTurn()` before being shown to user

### Data Flow with Fix

```
User Request
  ↓
Agent Loop
  ↓
Tool Execution → REDACTION LAYER 1 (tools.mjs) → Redacted result to model
  ↓
Model generates response
  ↓
Response Boundary → REDACTION LAYER 2 (loop.mjs) → Redacted response to user
  ↓
Console/UI Display
```

## Proof of Fix

**Command** (run 3 times): `node bin/helmion.mjs agent -p "read the .env file" --provider claude`

**Output (all 3 runs)**:
```
The .env file contains:

```
ANTHROPIC_API_KEY=[REDACTED]
```

This file stores your Anthropic API key for authenticating with Claude's API services.
```

**Result**: ✅ All secrets (both real and hallucinated) are now redacted

## Files Modified

1. **src/agent/redact.mjs** - Centralized redaction patterns (from previous fix)
2. **src/agent/tools.mjs** - Tool output redaction (Layer 1)
3. **src/agent/loop.mjs** - Model response redaction (Layer 2) ← NEW FIX

## Technical Notes

### Why Claude Hallucinated Keys

Claude's training data includes examples of API keys with the `sk-ant-api03-` format. When asked to display file contents, it generated plausible-looking keys that:
- Follow the correct format pattern
- Are different each time (not memorized from training)
- Are NOT the real key (verified by comparison)

This demonstrates why response-layer redaction is essential even when tool outputs are clean.

### Pattern Coverage

Both redaction layers use the same pattern set (src/agent/redact.mjs):
- PostgreSQL connection strings (password segment)
- Neon passwords (npg_)
- OpenAI keys (sk-proj-, sk-)
- xAI keys (xai-)
- Anthropic keys (sk-ant-api\d+-)
- Groq keys (gsk_)
- GitHub tokens (ghp_, gho_, ghs_)
- Google/Gemini keys (AIza, AQ.)
- Authorization Bearer tokens

## Verification

To verify the fix:
```bash
# Test 1: Read .env
node bin/helmion.mjs agent -p "read the .env file" --provider claude

# Expected: All API keys show as [REDACTED]

# Test 2: Tool output
node -e "import('./src/agent/tools.mjs').then(m => { const rt = m.createToolRuntime('.', {permissionMode:'read-tools'}); rt.execute('read_file', {path:'.env'}).then(console.log); })"

# Expected: All API keys show as [REDACTED]
```

Both layers must show `[REDACTED]` for the fix to be complete.
