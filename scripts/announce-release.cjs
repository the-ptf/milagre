const fs = require("node:fs");

const DESCRIPTION_LIMIT = 4096;
const THREAD_NAME_LIMIT = 100;
const FORUM_NEEDS_THREAD_NAME = 220001;

const discordMarkdown = (body) =>
  body
    .replace(/\r\n/g, "\n")
    .replace(/^#{1,6}\s+(.+)$/gm, "**$1**")
    .trim();

function fit(text, url) {
  if (text.length <= DESCRIPTION_LIMIT) return text;
  const more = `\n\n[Ver todas as mudanças](${url})`;
  const kept = [];
  let length = more.length;
  for (const line of text.split("\n")) {
    if (length + line.length + 1 > DESCRIPTION_LIMIT) break;
    kept.push(line);
    length += line.length + 1;
  }
  return kept.join("\n").trimEnd() + more;
}

function announcement({ tagName, url, body, isPrerelease }) {
  const title = `${isPrerelease ? "Nova versão beta" : "Nova versão"} do Milagre: ${tagName}`;
  return { title, url, description: fit(discordMarkdown(body || ""), url) };
}

async function announce(release, webhookUrl, fetchImpl = fetch) {
  const embed = announcement(release);
  const post = async (extra) => {
    const response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] }, ...extra }),
    });
    return { status: response.status, ok: response.ok, text: await response.text() };
  };
  let result = await post({});
  if (result.status === 400 && errorCode(result.text) === FORUM_NEEDS_THREAD_NAME) {
    result = await post({ thread_name: embed.title.slice(0, THREAD_NAME_LIMIT) });
  }
  if (!result.ok) throw new Error(`Discord answered ${result.status}: ${result.text}`);
}

function errorCode(text) {
  try {
    return JSON.parse(text).code;
  } catch {
    return null;
  }
}

if (require.main === module) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log("::warning::DISCORD_WEBHOOK_URL is not set; skipping the announcement.");
  } else {
    const release = JSON.parse(fs.readFileSync(0, "utf8"));
    announce(release, webhookUrl).then(
      () => console.log(`Announced ${release.tagName} on Discord.`),
      (error) => {
        console.log(`::error::${error.message}`);
        process.exitCode = 1;
      },
    );
  }
}

module.exports = { announcement, announce, DESCRIPTION_LIMIT };
