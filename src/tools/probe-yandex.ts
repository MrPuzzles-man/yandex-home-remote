import { loadConfig } from "../config/env.js";
import { YandexIotClient } from "../integrations/yandex-iot.client.js";

const config = loadConfig();
if (!config.YANDEX_IOT_TOKEN) {
  console.error("YANDEX_IOT_TOKEN не задан. Скопируйте .env.example в .env и добавьте OAuth-токен.");
  process.exitCode = 1;
} else {
  const client = new YandexIotClient(config.YANDEX_IOT_TOKEN, config.YANDEX_IOT_BASE_URL);
  try {
    const catalog = await client.getUserInfo();
    console.log(
      JSON.stringify(
        {
          ok: true,
          households: catalog.households.length,
          rooms: catalog.rooms.length,
          devices: catalog.devices.map((device) => ({
            id: device.id,
            name: device.name,
            type: device.type,
            status: device.status ?? "unknown",
            capabilities: device.capabilities.map((capability) => ({
              type: capability.type,
              instance: capability.parameters.instance ?? capability.state?.instance ?? null,
            })),
          })),
          groups: catalog.groups.length,
          scenarios: catalog.scenarios.map((scenario) => ({ id: scenario.id, name: scenario.name })),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
