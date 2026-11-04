export type HomeAssistantCall = {
  domain: string;
  service: string;
  data: Record<string, unknown>;
};

export type HomeAssistantMediaPlayer = {
  entityId: string;
  name: string;
  state: string;
  volumeLevel?: number;
};

export interface HomeAssistantGateway {
  callService(call: HomeAssistantCall): Promise<void>;
  listMediaPlayers(): Promise<HomeAssistantMediaPlayer[]>;
}

export class HomeAssistantError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "HomeAssistantError";
  }
}

export class HomeAssistantClient implements HomeAssistantGateway {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly retryDelayMs = 750,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async callService(call: HomeAssistantCall): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetcher(`${this.baseUrl}/api/services/${call.domain}/${call.service}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(call.data),
        });
      } catch (error) {
        if (attempt < 3) {
          await delay(this.retryDelayMs * attempt);
          continue;
        }
        throw new HomeAssistantError(
          `Home Assistant не отвечает: ${error instanceof Error ? error.message : "ошибка сети"}`,
        );
      }

      if (response.ok) return;
      const detail = (await response.text()).slice(0, 300);
      if (response.status >= 500 && response.status <= 504 && attempt < 3) {
        await delay(this.retryDelayMs * attempt);
        continue;
      }
      throw new HomeAssistantError(
        `Home Assistant отклонил команду (${response.status})${detail ? `: ${detail}` : ""}`,
        response.status,
      );
    }
  }

  async listMediaPlayers(): Promise<HomeAssistantMediaPlayer[]> {
    const response = await this.fetcher(`${this.baseUrl}/api/states`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) throw new HomeAssistantError(`Не удалось получить колонки (${response.status})`, response.status);
    const states = (await response.json()) as Array<{
      entity_id?: unknown;
      state?: unknown;
      attributes?: { friendly_name?: unknown; sound_mode_list?: unknown };
    }>;
    return states
      .filter(
        (item) =>
          typeof item.entity_id === "string" &&
          item.entity_id.startsWith("media_player.") &&
          (item.entity_id.startsWith("media_player.yandex_station_") || Array.isArray(item.attributes?.sound_mode_list)),
      )
      .map((item) => ({
        entityId: item.entity_id as string,
        name:
          typeof item.attributes?.friendly_name === "string"
            ? item.attributes.friendly_name
            : (item.entity_id as string),
        state: typeof item.state === "string" ? item.state : "unknown",
        ...(typeof (item.attributes as { volume_level?: unknown } | undefined)?.volume_level === "number"
          ? { volumeLevel: (item.attributes as { volume_level: number }).volume_level }
          : {}),
      }));
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
