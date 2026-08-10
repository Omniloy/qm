import { readFileSync } from "node:fs";
import { BRAND } from "../../plugins/chassis/src/brand.ts";

interface SlackBotManifest {
  display_information: { name: string; description: string };
  features: { bot_user: { display_name: string } };
}

export function slackBotManifestCreationUrl(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../../cli/templates/slack-manifest.json", import.meta.url), "utf8"),
  ) as SlackBotManifest;
  manifest.display_information.name = BRAND.slackAppName;
  manifest.display_information.description = BRAND.slackAppDescription;
  manifest.features.bot_user.display_name = BRAND.slackBotHandle;
  const url = new URL("https://api.slack.com/apps");
  url.searchParams.set("new_app", "1");
  url.searchParams.set("manifest_json", JSON.stringify(manifest));
  return url.toString();
}
