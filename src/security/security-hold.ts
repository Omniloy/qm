import type { SecurityScreenCategory, ToolResultContext } from "./security-posture.ts";

export interface SecurityHold {
  source: ToolResultContext;
  step: string;
  category: SecurityScreenCategory;
  reason?: string;
  evidence?: string;
  scheduledTask?: { id: string; title?: string };
}

interface SecurityHoldFact {
  label: string;
  value: string;
}

export interface SecurityHoldView {
  title: string;
  subject?: string;
  categoryLabel: string;
  explanation: string;
  facts: SecurityHoldFact[];
  evidence?: string;
  allowEffect: string;
  keepEffect: string;
}

export const SECURITY_CATEGORY_LABELS: Record<SecurityScreenCategory, string> = {
  instruction_override: "Instruction override",
  credential_request: "Credential request",
  data_exfiltration: "Data exfiltration",
  security_weakening: "Weakening security",
  hidden_behavior: "Hidden behavior",
  other: "Untrusted instructions",
};

const CATEGORY_CONCERNS: Record<SecurityScreenCategory, string> = {
  instruction_override: "tell the assistant to ignore or replace its instructions",
  credential_request: "ask for or hand over credentials, tokens or other secrets",
  data_exfiltration: "tell the assistant to send data somewhere it shouldn't go",
  security_weakening: "weaken a security control",
  hidden_behavior: "tell the assistant to hide what it is doing",
  other: "give the assistant instructions it has no standing to give",
};

export function securityHoldSourceKey(source: ToolResultContext): string {
  switch (source.kind) {
    case "skill":
      return `skill:${source.skillId}`;
    case "command":
      return "command";
    case "web":
      return `web:${source.host}`;
    case "file":
      return "file";
    case "tool":
      return `tool:${source.server ?? ""}:${source.tool}`;
  }
}

export function securityHoldSourceLabel(source: ToolResultContext): string {
  switch (source.kind) {
    case "skill": {
      let standing = source.owner ? `owned by ${source.owner}` : "shared skill";
      if (source.builtIn) standing = "built-in, managed by the org";
      return `Skill ${source.name} · v${source.version} · ${standing}`;
    }
    case "command":
      return `Command: ${source.command}`;
    case "web":
      return `Content from ${source.host} (via ${source.tool})`;
    case "file":
      return `File ${source.path}`;
    case "tool":
      return `Tool ${source.tool}${source.action ? ` (${source.action})` : ""}${source.server ? ` from ${source.server}` : ""}`;
  }
}

export function securityHoldStep(source: ToolResultContext, scheduledTask?: SecurityHold["scheduledTask"]): string {
  let step: string;
  switch (source.kind) {
    case "skill":
      step = source.path ? `Reading ${source.path} from the skill` : "Reading the skill's instructions";
      break;
    case "command":
      step = source.purpose ? `Running a command: ${source.purpose}` : "Running a command";
      break;
    case "web":
      step = `Fetching content from ${source.host}`;
      break;
    case "file":
      step = `Reading ${source.path}`;
      break;
    case "tool":
      step = `Using the ${source.tool} tool`;
      break;
  }
  return scheduledTask ? `${step} · scheduled task ${scheduledTask.title ?? scheduledTask.id}` : step;
}

function heldContent(source: ToolResultContext): { title: string; subject?: string; what: string; without: string } {
  switch (source.kind) {
    case "skill":
      return {
        title: `Paused: content from the ${source.name} skill`,
        subject: source.name,
        what: `the ${source.name} skill's instructions`,
        without: `the ${source.name} instructions`,
      };
    case "command":
      return { title: "Paused: output of a command", what: "the output of a command", without: "the command's output" };
    case "web":
      return {
        title: `Paused: content from ${source.host}`,
        subject: source.host,
        what: `content fetched from ${source.host}`,
        without: "this content",
      };
    case "file":
      return {
        title: `Paused: content of ${source.path}`,
        subject: source.path,
        what: `the file ${source.path}`,
        without: "this file",
      };
    case "tool":
      return {
        title: `Paused: output of the ${source.tool} tool`,
        subject: source.tool,
        what: `the output of the ${source.tool} tool`,
        without: "this output",
      };
  }
}

export function securityHoldView(hold: SecurityHold): SecurityHoldView {
  const held = heldContent(hold.source);
  const task = hold.scheduledTask ? (hold.scheduledTask.title ?? hold.scheduledTask.id) : undefined;
  const title = task && hold.source.kind === "command" ? `Paused: output of a command in ${task}` : held.title;
  const subject = task && hold.source.kind === "command" ? task : held.subject;
  const unattended = task ? ` It happened in the scheduled task ${task}, so nobody was there to approve it.` : "";
  const builtInNote =
    hold.source.kind === "skill" && hold.source.builtIn
      ? " It's built-in documentation, so allowing it is usually safe."
      : "";
  return {
    title,
    ...(subject ? { subject } : {}),
    categoryLabel: SECURITY_CATEGORY_LABELS[hold.category],
    explanation: `The security screen held back ${held.what} before the assistant read it, because it appears to ${CATEGORY_CONCERNS[hold.category]}.${unattended}`,
    facts: [
      { label: "Source", value: securityHoldSourceLabel(hold.source) },
      { label: "Step", value: hold.step },
      ...(hold.reason ? [{ label: "Screener's reason", value: hold.reason }] : []),
    ],
    ...(hold.evidence ? { evidence: hold.evidence } : {}),
    allowEffect: task
      ? `The content is passed to the assistant once and this run of ${task} continues.${builtInNote}`
      : `The assistant reads this content for this step only and carries on.${builtInNote}`,
    keepEffect: task
      ? `This run of ${task} stops without ${held.without}. The next scheduled run starts fresh.`
      : `The assistant stops here without ${held.without}. Send a message to carry on without it.`,
  };
}
