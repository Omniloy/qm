import { buildApp, type BuiltApp } from "../../src/wiring.ts";
import { encodeRef, skillRef } from "../../src/acl/resource-ref.ts";
import { scopeId, type ScopeId } from "../../src/types.ts";
import { testConfig } from "./test-config.ts";

export const ORG_SCOPE = scopeId("org", "default-org");
export const ADMIN = "admin-alice";

export async function ownerFixture(): Promise<BuiltApp> {
  const built = buildApp(testConfig());
  await built.directory.replace(
    ["U1", "U2", "U3", "U4"].map((principalId) => ({
      principalId,
      displayName: `Person ${principalId}`,
      type: "internal",
    })),
  );
  await built.directory.replaceChannels(
    [
      { channelId: "CPRIV", name: "squad", isPrivate: true },
      { channelId: "CPUB", name: "general", isPrivate: false },
    ],
    [
      { channelId: "CPRIV", principalId: "U1" },
      { channelId: "CPRIV", principalId: "U2" },
      { channelId: "CPUB", principalId: "U1" },
      { channelId: "CPUB", principalId: "U3" },
    ],
  );
  return built;
}

export async function publishSkill(
  built: BuiltApp,
  opts: { owner: string; name: string; home?: ScopeId; body?: string; createdBy?: string; ownerId?: string },
) {
  const skill = await built.skills.create({
    scopeId: opts.home ?? scopeId("personal", opts.owner),
    manifest: {
      name: opts.name,
      description: opts.name,
      requiredCapabilities: [],
      body: opts.body ?? `# ${opts.name}`,
    },
    createdBy: opts.createdBy ?? opts.owner,
    ...(opts.ownerId ? { ownerId: opts.ownerId } : {}),
  });
  await built.skills.review(skill.id, "reviewer", []);
  return built.skills.publish(skill.id);
}

export async function grantsOf(built: BuiltApp, id: string) {
  const ref = encodeRef(skillRef(id));
  return (await built.acl.list()).filter((g) => g.ref === ref);
}

export const live = { liveActor: true };
