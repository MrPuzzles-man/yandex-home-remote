import type { HomeAssistantGateway, HomeAssistantMediaPlayer } from "../integrations/home-assistant.client.js";
import type { AppDatabase, MusicQueueItem } from "../db/database.js";
import type { MusicAssistantClient } from "../integrations/music-assistant.client.js";

type DisplayQueueItem = { query: string };

export class MusicNotConfiguredError extends Error {
  constructor() {
    super("Музыкальный модуль не настроен. Нужны Home Assistant и проверенная интеграция YandexStation.");
    this.name = "MusicNotConfiguredError";
  }
}

export class MusicService {
  private selectedEntityId: string | undefined;
  private lastPlayCommandAt = 0;
  private reconcileRunning = false;

  constructor(
    private readonly gateway?: HomeAssistantGateway,
    entityId?: string,
    private readonly database?: AppDatabase,
    private readonly musicAssistant?: MusicAssistantClient,
  ) {
    this.selectedEntityId = entityId;
  }

  getStatus(): { configured: boolean; reason?: string } {
    return this.gateway && this.selectedEntityId
      ? { configured: true }
      : { configured: false, reason: "Нужны HOME_ASSISTANT_TOKEN и YANDEX_STATION_ENTITY_ID" };
  }

  async setVolume(level: number): Promise<void> {
    const { gateway, entityId } = this.requireConfigured();
    if (!Number.isInteger(level) || level < 0 || level > 10) {
      throw new RangeError("Громкость должна быть целым числом от 0 до 10");
    }
    await gateway.callService({
      domain: "media_player",
      service: "volume_set",
      data: { entity_id: entityId, volume_level: level / 10 },
    });
  }

  async play(query: string): Promise<void> {
    const { gateway, entityId } = this.requireConfigured();
    const normalized = query.trim();
    if (!normalized) throw new Error("Укажите исполнителя и название трека");
    await gateway.callService({
      domain: "media_player",
      service: "play_media",
      data: {
        entity_id: entityId,
        media_content_type: "command",
        media_content_id: `Включи песню ${normalized}`,
      },
    });
    this.lastPlayCommandAt = Date.now();
  }

  async enqueue(query: string, actorId: string): Promise<{
    item: MusicQueueItem;
    position: number;
    started: boolean;
  }> {
    const { entityId } = this.requireConfigured();
    if (!this.database) throw new Error("Хранилище музыкальной очереди не настроено");
    const normalized = query.trim();
    if (!normalized) throw new Error("Укажите исполнителя и название трека");
    if (normalized.length > 70) throw new Error("Название запроса должно быть не длиннее 70 символов");

    let actualPlaying = false;
    if (this.musicAssistant) {
      const playback = await this.musicAssistant.getPlayback().catch(() => undefined);
      actualPlaying = Boolean(playback?.current && playback.state === "playing");
      this.database.syncCurrentMusicTrack(entityId, playback?.current?.title);
    }
    const item = this.database.enqueueMusicTrack(entityId, actorId, normalized);
    const current = this.database.getCurrentMusicTrack(entityId);
    if (!current && !actualPlaying) {
      this.database.markMusicTrackPlaying(item.id);
      try {
        await this.play(normalized);
      } catch (error) {
        this.database.markMusicTrackFailed(item.id);
        throw error;
      }
      return { item: this.database.getCurrentMusicTrack(entityId)!, position: 1, started: true };
    }

    // Keep pending tracks in our own queue. Sending "Добавь песню ... в
    // очередь" to Alice is not deterministic: on some Station firmware it
    // starts the requested track immediately and interrupts the current one.
    return {
      item,
      position: this.database.getMusicQueuePosition(entityId, item.id) + (actualPlaying && !current ? 1 : 0),
      started: false,
    };
  }

  async getQueue(): Promise<{ current?: DisplayQueueItem; pending: DisplayQueueItem[] }> {
    if (this.musicAssistant) {
      const playback = await this.musicAssistant.getPlayback();
      if (this.selectedEntityId && this.database) {
        this.database.syncCurrentMusicTrack(this.selectedEntityId, playback.current?.title);
      }
      return {
        ...(playback.current ? { current: { query: playback.current.title } } : {}),
        pending: this.selectedEntityId && this.database
          ? this.database.listPendingMusicTracks(this.selectedEntityId).map((item) => ({ query: item.query }))
          : [],
      };
    }
    const entityId = this.selectedEntityId;
    if (!entityId || !this.database) return { pending: [] };
    return {
      pending: this.database.listPendingMusicTracks(entityId),
    };
  }

  async nextQueueTrack(): Promise<DisplayQueueItem | undefined> {
    const { entityId } = this.requireConfigured();
    if (!this.database) throw new Error("Хранилище музыкальной очереди не настроено");
    const next = this.database.advanceMusicQueue(entityId);
    if (!next) return undefined;
    try {
      await this.play(next.query);
      return next;
    } catch (error) {
      this.database.markMusicTrackFailed(next.id);
      throw error;
    }
  }

  clearPendingQueue(): number {
    const entityId = this.selectedEntityId;
    if (!entityId || !this.database) return 0;
    return this.database.clearPendingMusicQueue(entityId);
  }

  async clearQueue(): Promise<number> {
    const entityId = this.selectedEntityId;
    if (!entityId || !this.database) return 0;
    // Music Assistant is only a best-effort telemetry source. Its outage must
    // not prevent the owner from clearing the authoritative SQLite queue.
    if (this.musicAssistant) await this.musicAssistant.clear().catch(() => undefined);
    return this.database.clearActiveMusicQueue(entityId);
  }

  async speak(text: string): Promise<void> {
    const { gateway, entityId } = this.requireConfigured();
    const normalized = text.trim();
    if (!normalized) throw new Error("Введите фразу для произнесения");
    if (normalized.length > 100) throw new Error("Фраза должна быть не длиннее 100 символов");
    await gateway.callService({
      domain: "media_player",
      service: "play_media",
      data: {
        entity_id: entityId,
        media_content_type: "text",
        media_content_id: normalized,
      },
    });
  }

  async command(text: string): Promise<void> {
    const { gateway, entityId } = this.requireConfigured();
    const normalized = text.trim();
    if (!normalized) throw new Error("Команда Алисе не может быть пустой");
    if (normalized.length > 100) throw new Error("Команда должна быть не длиннее 100 символов");
    await gateway.callService({
      domain: "media_player",
      service: "play_media",
      data: {
        entity_id: entityId,
        media_content_type: "command",
        media_content_id: normalized,
      },
    });
  }

  async resume(): Promise<void> {
    if (this.musicAssistant) {
      const entityId = this.selectedEntityId;
      const playback = await this.musicAssistant.getPlayback().catch(() => undefined);
      const expected = entityId && this.database
        ? this.database.syncCurrentMusicTrack(entityId, playback?.current?.title)
        : undefined;
      // When the player is already playing or paused but exposes no title,
      // continuing it is safer than replaying a possibly stale SQLite row.
      if (playback?.state === "playing" || playback?.state === "paused") {
        return this.playerService("media_play");
      }
      if (!playback?.current && expected) return this.play(expected.query);
      return this.playerService("media_play");
    }
    await this.playerService("media_play");
  }

  async pause(): Promise<void> {
    await this.playerService("media_pause");
  }

  async reconcileQueue(): Promise<void> {
    if (this.reconcileRunning || !this.musicAssistant || !this.database || !this.selectedEntityId) return;
    if (Date.now() - this.lastPlayCommandAt < 20_000) return;
    this.reconcileRunning = true;
    try {
      const playback = await this.musicAssistant.getPlayback();
      if (playback.current) {
        this.database.syncCurrentMusicTrack(this.selectedEntityId, playback.current.title);
        return;
      }
      if (playback.state !== "idle") return;
      const next = this.database.advanceMusicQueue(this.selectedEntityId);
      if (!next) return;
      try {
        await this.play(next.query);
      } catch (error) {
        this.database.markMusicTrackFailed(next.id);
        throw error;
      }
    } finally {
      this.reconcileRunning = false;
    }
  }

  async listPlayers(): Promise<HomeAssistantMediaPlayer[]> {
    if (!this.gateway) throw new MusicNotConfiguredError();
    return this.gateway.listMediaPlayers();
  }

  async selectPlayer(entityId: string): Promise<HomeAssistantMediaPlayer> {
    const player = (await this.listPlayers()).find((candidate) => candidate.entityId === entityId);
    if (!player) throw new Error("Колонка не найдена в Home Assistant");
    this.selectedEntityId = player.entityId;
    return player;
  }

  getSelectedEntityId(): string | undefined {
    return this.selectedEntityId;
  }

  private async playerService(service: "media_play" | "media_pause"): Promise<void> {
    const { gateway, entityId } = this.requireConfigured();
    await gateway.callService({
      domain: "media_player",
      service,
      data: { entity_id: entityId },
    });
  }

  private requireConfigured(): { gateway: HomeAssistantGateway; entityId: string } {
    if (!this.gateway || !this.selectedEntityId) throw new MusicNotConfiguredError();
    return { gateway: this.gateway, entityId: this.selectedEntityId };
  }
}
