import "dotenv/config";
import { z } from "zod";

const optionalNonEmpty = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_PATH: z.string().default("./data/home-remote.db"),
  LOG_LEVEL: z.string().default("info"),
  YANDEX_IOT_BASE_URL: z.url().default("https://api.iot.yandex.net"),
  YANDEX_IOT_TOKEN: optionalNonEmpty,
  TELEGRAM_BOT_TOKEN: optionalNonEmpty,
  OWNER_TELEGRAM_ID: z.preprocess(
    (value) => (value === "" || value === undefined ? undefined : value),
    z.coerce.number().int().positive().optional(),
  ),
  CALLBACK_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  HOME_ASSISTANT_URL: optionalNonEmpty,
  HOME_ASSISTANT_TOKEN: optionalNonEmpty,
  YANDEX_STATION_ENTITY_ID: optionalNonEmpty,
  MUSIC_ASSISTANT_URL: optionalNonEmpty,
  MUSIC_ASSISTANT_TOKEN: optionalNonEmpty,
  MUSIC_ASSISTANT_PLAYER_ID: optionalNonEmpty,
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  return schema.parse(source);
}
