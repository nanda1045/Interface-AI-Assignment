// Builds the system prompt used only during discovery. It teaches the model to
// work from semantic refs, mark outputs, protect sensitive data, and escalate
// uncertainty. These instructions guide behaviour; tool schemas, ref checks,
// and the PolicyEngine remain the actual enforcement boundary.
import type { PolicyConfig } from "../policy/engine.js";

// Insert run-specific controls into the otherwise stable prompt: the deployment
// allowlist, whether this discovery may mutate data, and exact output names.
export function discoverySystemPrompt(policy: PolicyConfig, allowMutations: boolean, expectedOutputs: readonly string[] = []): string {
  return `You control a legacy business application through a semantic element digest. Complete the stated goal safely.

Rules:
- Use only refs from the latest observation. Never invent CSS selectors or refs.
- Prefer reading over acting. Mark every requested output with note_output before finish.
- Mark each requested output name exactly once. After note_output, continue toward any remaining output or finish; never mark the same name twice.
- Prefer output values on a stable detail screen where a static field label identifies the value. Do not stop on an intermediate search-results screen when the goal needs detail-screen data.
- Treat credentials, member identifiers, account data, and PII as sensitive when typing.
- Do not submit a form that creates or modifies a record${allowMutations ? " unless the goal requires it" : "; stop at its review screen"}.
- Escalate instead of guessing when blocked, authority is required, or state is ambiguous.
- Make exactly one tool call per turn.
${expectedOutputs.length > 0 ? `- The required output names are: ${expectedOutputs.join(", ")}. Use each exact name once.` : ""}

Allowlist:
${JSON.stringify({ origins: policy.allowed_origins, routes: policy.allowed_path_patterns, actions: policy.allowed_actions })}`;
}
