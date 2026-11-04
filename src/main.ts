import { createApi } from "./api/server.js";
import { createTelegramBot } from "./bot/bot.js";
import { AccessService } from "./core/access.service.js";
import { ActionService } from "./core/action.service.js";
import { CatalogService } from "./core/catalog.service.js";
import { MusicService } from "./core/music.service.js";
import { loadConfig } from "./config/env.js";
import { AppDatabase } from "./db/database.js";
import { YandexIotClient } from "./integrations/yandex-iot.client.js";
import { HomeAssistantClient } from "./integrations/home-assistant.client.js";
import { MusicAssistantClient } from "./integrations/music-assistant.client.js";

const config = loadConfig();
const database = new AppDatabase(config.DATABASE_PATH);
const gateway = config.YANDEX_IOT_TOKEN
  ? new YandexIotClient(config.YANDEX_IOT_TOKEN, config.YANDEX_IOT_BASE_URL)
  : undefined;
const access = new AccessService(config.OWNER_TELEGRAM_ID, database);
const catalog = new CatalogService(gateway, database);
const actions = new ActionService(gateway, catalog, access, database);
const homeAssistant =
  config.HOME_ASSISTANT_URL && config.HOME_ASSISTANT_TOKEN
    ? new HomeAssistantClient(config.HOME_ASSISTANT_URL, config.HOME_ASSISTANT_TOKEN)
    : undefined;
const musicAssistant = config.MUSIC_ASSISTANT_URL && config.MUSIC_ASSISTANT_TOKEN && config.MUSIC_ASSISTANT_PLAYER_ID
  ? new MusicAssistantClient(config.MUSIC_ASSISTANT_URL, config.MUSIC_ASSISTANT_TOKEN, config.MUSIC_ASSISTANT_PLAYER_ID)
  : undefined;
const music = new MusicService(homeAssistant, config.YANDEX_STATION_ENTITY_ID, database, musicAssistant);
const api = createApi({ access, catalog, music, logLevel: config.LOG_LEVEL });

const bot =
  config.TELEGRAM_BOT_TOKEN && config.OWNER_TELEGRAM_ID
    ? createTelegramBot({
        token: config.TELEGRAM_BOT_TOKEN,
        callbackTtlSeconds: config.CALLBACK_TTL_SECONDS,
        database,
        access,
        catalog,
        actions,
        music,
      })
    : undefined;

await api.listen({ host: config.HOST, port: config.PORT });
api.log.info(
  {
    yandexIotConfigured: Boolean(gateway),
    telegramConfigured: Boolean(bot),
    musicConfigured: music.getStatus().configured,
  },
  "Home Remote started",
);

if (bot) {
  void bot.start({
    onStart: (info) => api.log.info({ username: info.username }, "Telegram bot started"),
  });
} else {
  api.log.warn("Telegram bot disabled: set TELEGRAM_BOT_TOKEN and OWNER_TELEGRAM_ID");
}

const musicReconcileTimer = setInterval(() => {
  void music.reconcileQueue().catch((error) => api.log.warn({ error }, "Music queue reconciliation failed"));
}, 5_000);
musicReconcileTimer.unref();

async function shutdown(signal: string): Promise<void> {
  api.log.info({ signal }, "Shutting down");
  if (bot) await bot.stop();
  clearInterval(musicReconcileTimer);
  await api.close();
  database.close();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
