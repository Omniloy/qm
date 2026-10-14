import type { SecurityScreenCategory, ToolResultContext } from "./security-posture.ts";

export interface SecurityHold {
  source: ToolResultContext;
  category: SecurityScreenCategory;
  reason?: string;
  evidence?: string;
  scheduledTask?: { id: string; title?: string; ownerId?: string };
}

interface SecurityHoldFact {
  label: string;
  value: string;
}

export interface SecurityHoldView {
  title: string;
  held: string;
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

function securityHoldSourceLabel(source: ToolResultContext): string {
  switch (source.kind) {
    case "skill": {
      let standing = source.owner ? `owned by ${source.owner}` : "shared skill";
      if (source.packId) standing = `Skill pack ${source.packId}`;
      if (source.builtIn) standing = "built-in";
      return `Skill ${source.name} · v${source.version} · ${standing}`;
    }
    case "command":
      return `Command: ${source.command}`;
    case "web":
      return `Requested URL host: ${source.host} (via ${source.tool})`;
    case "file":
      return `File ${source.path}`;
    case "tool":
      return `Tool ${source.tool}${source.action ? ` (${source.action})` : ""}${source.server ? ` from ${source.server}` : ""}`;
  }
}

export function securityHoldGroupLabel(source: ToolResultContext): string {
  if (source.kind === "command") return "Commands";
  if (source.kind === "file") return "Files";
  if (source.kind === "skill") return `Skill ${source.name}`;
  return securityHoldSourceLabel(source);
}

export function securityHoldStep(hold: Pick<SecurityHold, "source" | "scheduledTask">): string {
  const { source, scheduledTask } = hold;
  let step: string;
  switch (source.kind) {
    case "skill":
      step = skillAsset(source) ? `Reading ${source.path} from the skill` : "Reading the skill's instructions";
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

function skillAsset(source: Extract<ToolResultContext, { kind: "skill" }>): boolean {
  return source.path !== undefined && source.path !== "SKILL.md";
}

interface HeldContent {
  title: string;
  subject?: string;
  what: string;
  plural: boolean;
}

function heldContent(source: ToolResultContext): HeldContent {
  switch (source.kind) {
    case "skill":
      return skillAsset(source)
        ? {
            title: `Paused: content from the ${source.name} skill`,
            subject: source.name,
            what: `content from the ${source.name} skill (${source.path})`,
            plural: false,
          }
        : {
            title: `Paused: content from the ${source.name} skill`,
            subject: source.name,
            what: `the ${source.name} skill's instructions`,
            plural: true,
          };
    case "command":
      return { title: "Paused: output of a command", what: "the output of a command", plural: false };
    case "web":
      return {
        title: `Paused: content from ${source.host}`,
        subject: source.host,
        what: `content fetched from ${source.host}`,
        plural: false,
      };
    case "file":
      return {
        title: `Paused: content of ${source.path}`,
        subject: source.path,
        what: `the file ${source.path}`,
        plural: false,
      };
    case "tool":
      return {
        title: `Paused: output of the ${source.tool} tool`,
        subject: source.tool,
        what: `the output of the ${source.tool} tool`,
        plural: false,
      };
  }
}

export function securityHoldView(hold: SecurityHold): SecurityHoldView {
  const held = heldContent(hold.source);
  const task = hold.scheduledTask ? (hold.scheduledTask.title ?? hold.scheduledTask.id) : undefined;
  const commandInTask = task !== undefined && hold.source.kind === "command";
  const title = commandInTask ? `Paused: output of a command in ${task}` : held.title;
  const subject = commandInTask ? task : held.subject;
  const [pronoun, verb] = held.plural ? ["them", "they appear"] : ["it", "it appears"];
  const unattended = task ? ` It happened in the scheduled task ${task}, so nobody was there to approve it.` : "";
  return {
    title,
    held: title.replace(/^Paused: /, ""),
    ...(subject ? { subject } : {}),
    categoryLabel: SECURITY_CATEGORY_LABELS[hold.category],
    explanation: `The security screen held back ${held.what} before the assistant read ${pronoun}, because ${verb} to ${CATEGORY_CONCERNS[hold.category]}.${unattended}`,
    facts: [
      { label: "Source", value: securityHoldSourceLabel(hold.source) },
      { label: "Step", value: securityHoldStep(hold) },
      ...(hold.reason ? [{ label: "Screener's reason", value: hold.reason }] : []),
    ],
    ...(hold.evidence ? { evidence: hold.evidence } : {}),
    allowEffect: task
      ? `The assistant gets this exact content once, as untrusted data, and this run of ${task} carries on and delivers as usual. It stays in that run's history.`
      : "The assistant gets this exact content once, as untrusted data, and carries on. It stays in this conversation's history.",
    keepEffect: task
      ? `This run of ${task} stops without it and delivers nothing. The next scheduled run starts fresh.`
      : "The content stays out of the conversation and the assistant stops here. Send a message to carry on without it.",
  };
}
