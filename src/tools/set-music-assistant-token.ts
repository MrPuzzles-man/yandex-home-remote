import { readFileSync, writeFileSync } from "node:fs";

const playerId = process.argv[2]?.trim();
if (!playerId) {
  throw new Error("Передайте публичный ID плеера первым аргументом");
}

const token = (await readStdin()).trim();
if (token.split(".").length !== 3) throw new Error("Некорректный Music Assistant token");

const envPath = ".env";
let content = readFileSync(envPath, "utf8");
content = setEnv(content, "MUSIC_ASSISTANT_URL", "http://host.docker.internal:8095");
content = setEnv(content, "MUSIC_ASSISTANT_TOKEN", token);
content = setEnv(content, "MUSIC_ASSISTANT_PLAYER_ID", playerId);
writeFileSync(envPath, content, "utf8");
console.log("Music Assistant token сохранён в .env");

function setEnv(content: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(content)) return content.replace(pattern, line);
  return `${content.trimEnd()}\n${line}\n`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
