import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { claudeChildEnv, claudeProcessIdentity, spawnClaudeProcess } from "../harness/claude-harness.ts";
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

export interface SubscriptionProbeResult {
  ok: boolean;
  detail?: string;
}

const PROBE_TIMEOUT_MS = 25_000;

/**
 * Confirm a subscription token by using it, through the same path a turn takes.
 *
 * Anthropic publishes no endpoint that validates a subscription token, and the
 * headers Claude Code sends are not a contract to reimplement — a hand-rolled
 * check would drift and start rejecting good tokens. So the check is one very
 * small real turn: it exercises the credential, the binary, and the precedence
 * rule in `claudeChildEnv` together, which is the combination that actually
 * decides whether the next agent run works.
 */
export async function probeClaudeSubscription(
  token: string,
  source: NodeJS.ProcessEnv,
): Promise<SubscriptionProbeResult> {
  const jail = mkdtempSync(join(tmpdir(), "qm-claude-probe-"));
  const identity = claudeProcessIdentity();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const probe = query({
      prompt: "Reply with the single word OK.",
      options: {
        abortController: controller,
        cwd: jail,
        env: claudeChildEnv({ ...source, CLAUDE_CODE_OAUTH_TOKEN: token }, jail),
        tools: [],
        skills: [],
        settingSources: [],
        strictMcpConfig: true,
        allowedTools: [],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        persistSession: false,
        systemPrompt: "Answer in one word.",
        model: "claude-haiku-4-5",
        ...(identity ? { spawnClaudeCodeProcess: (o: SpawnOptions) => spawnClaudeProcess(o, identity) } : {}),
      },
    });
    for await (const message of probe) {
      if (message.type !== "result") continue;
      if (message.subtype === "success" && !message.is_error) return { ok: true };
      return { ok: false, detail: "Claude rejected this token." };
    }
    return { ok: false, detail: "Claude did not answer." };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: controller.signal.aborted ? "The check timed out." : detail };
  } finally {
    clearTimeout(timeout);
    controller.abort();
    rmSync(jail, { recursive: true, force: true });
  }
}
