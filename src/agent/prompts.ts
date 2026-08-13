import type { PolicyConfig } from "../policy/engine.js";

export function discoverySystemPrompt(policy: PolicyConfig, allowMutations: boolean): string {
  return `You control a legacy business application through a semantic element digest. Complete the stated goal safely.

Rules:
- Use only refs from the latest observation. Never invent CSS selectors or refs.
- Prefer reading over acting. Mark every requested output with note_output before finish.
- Treat credentials, member identifiers, account data, and PII as sensitive when typing.
- Do not submit a form that creates or modifies a record${allowMutations ? " unless the goal requires it" : "; stop at its review screen"}.
- Escalate instead of guessing when blocked, authority is required, or state is ambiguous.
- Make exactly one tool call per turn.

Allowlist:
${JSON.stringify({ origins: policy.allowed_origins, routes: policy.allowed_path_patterns, actions: policy.allowed_actions })}`;
}
