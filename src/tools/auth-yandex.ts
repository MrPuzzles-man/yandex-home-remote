import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { YandexIotClient } from "../integrations/yandex-iot.client.js";

const redirectUri = "https://oauth.yandex.ru/verification_code";
const clientId = process.env.YANDEX_CLIENT_ID?.trim();
const clientSecret = process.env.YANDEX_CLIENT_SECRET?.trim();

if (!clientId || !clientSecret) {
  console.error(
    "Не заданы YANDEX_CLIENT_ID и YANDEX_CLIENT_SECRET. Запустите команду через PowerShell по инструкции в README.",
  );
  process.exitCode = 1;
} else {
  const authorizeUrl = new URL("https://oauth.yandex.ru/authorize");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", "iot:view iot:control");
  authorizeUrl.searchParams.set("force_confirm", "yes");

  console.log("Открываю страницу Яндекс OAuth.");
  console.log("Если браузер не открылся, перейдите по адресу:\n" + authorizeUrl.toString());
  try {
    const browser = spawn("explorer.exe", [authorizeUrl.toString()], {
      detached: true,
      stdio: "ignore",
    });
    browser.unref();
  } catch {
    // URL уже напечатан: ручное открытие остаётся рабочим fallback.
  }

  const readline = createInterface({ input: stdin, output: stdout });
  const code = (await readline.question("После подтверждения вставьте одноразовый код: ")).trim();
  readline.close();

  if (!code) {
    console.error("Код не введён.");
    process.exitCode = 1;
  } else {
    const response = await fetch("https://oauth.yandex.ru/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    const payload = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
      error_description?: string;
    };

    if (!response.ok || !payload.access_token) {
      console.error(
        `Яндекс не выдал токен: ${payload.error ?? response.status} — ${payload.error_description ?? "нет описания"}`,
      );
      process.exitCode = 1;
    } else {
      const client = new YandexIotClient(payload.access_token);
      const catalog = await client.getUserInfo();
      updateEnv("YANDEX_IOT_TOKEN", payload.access_token);
      if (payload.refresh_token) updateEnv("YANDEX_IOT_REFRESH_TOKEN", payload.refresh_token);
      console.log(
        `Готово. Токен проверен и записан в .env. Найдено устройств: ${catalog.devices.length}; сценариев: ${catalog.scenarios.length}.`,
      );
      console.log("Access token и refresh token в консоль не выводились.");
    }
  }
}

function updateEnv(key: string, value: string): void {
  let content = "";
  try {
    content = readFileSync(".env", "utf8");
  } catch {
    try {
      content = readFileSync(".env.example", "utf8");
    } catch {
      content = "";
    }
  }
  const line = `${key}=${value}`;
  const expression = new RegExp(`^${key}=.*$`, "m");
  content = expression.test(content)
    ? content.replace(expression, line)
    : `${content.trimEnd()}${content ? "\n" : ""}${line}\n`;
  writeFileSync(".env", content, { encoding: "utf8", mode: 0o600 });
}
