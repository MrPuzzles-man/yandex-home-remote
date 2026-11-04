import { describe, expect, it, vi } from "vitest";
import { MusicNotConfiguredError, MusicService } from "../src/core/music.service.js";
import type { HomeAssistantGateway } from "../src/integrations/home-assistant.client.js";
import { AppDatabase } from "../src/db/database.js";

describe("MusicService", () => {
  it("maps volume 3 to Home Assistant volume 0.3", async () => {
    const callService = vi.fn<HomeAssistantGateway["callService"]>().mockResolvedValue(undefined);
    const service = new MusicService({ callService, listMediaPlayers: vi.fn() }, "media_player.station");

    await service.setVolume(3);

    expect(callService).toHaveBeenCalledWith({
      domain: "media_player",
      service: "volume_set",
      data: { entity_id: "media_player.station", volume_level: 0.3 },
    });
  });

  it("sends a natural-language command to YandexStation", async () => {
    const callService = vi.fn<HomeAssistantGateway["callService"]>().mockResolvedValue(undefined);
    const service = new MusicService({ callService, listMediaPlayers: vi.fn() }, "media_player.station");

    await service.play("We're Not Gonna Take It группы Twisted Sister");

    expect(callService).toHaveBeenCalledWith({
      domain: "media_player",
      service: "play_media",
      data: {
        entity_id: "media_player.station",
        media_content_type: "command",
        media_content_id: "Включи песню We're Not Gonna Take It группы Twisted Sister",
      },
    });
  });

  it("sends speech as text instead of an Alice command", async () => {
    const callService = vi.fn<HomeAssistantGateway["callService"]>().mockResolvedValue(undefined);
    const service = new MusicService({ callService, listMediaPlayers: vi.fn() }, "media_player.station");

    await service.speak("Ужин готов");

    expect(callService).toHaveBeenCalledWith({
      domain: "media_player",
      service: "play_media",
      data: {
        entity_id: "media_player.station",
        media_content_type: "text",
        media_content_id: "Ужин готов",
      },
    });
  });

  it("sends a bounded Alice command", async () => {
    const callService = vi.fn<HomeAssistantGateway["callService"]>().mockResolvedValue(undefined);
    const service = new MusicService({ callService, listMediaPlayers: vi.fn() }, "media_player.station");

    await service.command("Расскажи прогноз погоды");

    expect(callService).toHaveBeenCalledWith({
      domain: "media_player",
      service: "play_media",
      data: {
        entity_id: "media_player.station",
        media_content_type: "command",
        media_content_id: "Расскажи прогноз погоды",
      },
    });
  });

  it.each([
    ["resume", "media_play"],
    ["pause", "media_pause"],
  ] as const)("maps %s to %s", async (method, expectedService) => {
    const callService = vi.fn<HomeAssistantGateway["callService"]>().mockResolvedValue(undefined);
    const service = new MusicService({ callService, listMediaPlayers: vi.fn() }, "media_player.station");
    await service[method]();
    expect(callService).toHaveBeenCalledWith({
      domain: "media_player",
      service: expectedService,
      data: { entity_id: "media_player.station" },
    });
  });

  it("stays disabled until both gateway and entity are configured", async () => {
    const service = new MusicService();
    expect(service.getStatus().configured).toBe(false);
    await expect(service.setVolume(3)).rejects.toBeInstanceOf(MusicNotConfiguredError);
  });

  it("persists later tracks without interrupting the current track", async () => {
    const database = new AppDatabase(":memory:");
    const callService = vi.fn<HomeAssistantGateway["callService"]>().mockResolvedValue(undefined);
    const service = new MusicService(
      { callService, listMediaPlayers: vi.fn() },
      "media_player.station",
      database,
    );

    const first = await service.enqueue("First Song", "owner");
    const second = await service.enqueue("Second Song", "friend");

    expect(first).toMatchObject({ position: 1, started: true });
    expect(second).toMatchObject({ position: 2, started: false });
    // SQLite is the requested queue, not proof of what the speaker is playing.
    expect((await service.getQueue()).current).toBeUndefined();
    expect((await service.getQueue()).pending.map((item) => item.query)).toEqual(["Second Song"]);
    expect(callService).toHaveBeenCalledTimes(1);

    const next = await service.nextQueueTrack();
    expect(next?.query).toBe("Second Song");
    expect(callService).toHaveBeenNthCalledWith(2, {
      domain: "media_player",
      service: "play_media",
      data: {
        entity_id: "media_player.station",
        media_content_type: "command",
        media_content_id: "Включи песню Second Song",
      },
    });
    expect(await service.clearQueue()).toBe(1);
    expect(await service.getQueue()).toEqual({ pending: [] });
    database.close();
  });

  it("continues an untitled active player instead of replaying stale SQLite state", async () => {
    const database = new AppDatabase(":memory:");
    const queued = database.enqueueMusicTrack("media_player.station", "owner", "Stale Song");
    database.markMusicTrackPlaying(queued.id);
    const callService = vi.fn<HomeAssistantGateway["callService"]>().mockResolvedValue(undefined);
    const musicAssistant = {
      getPlayback: vi.fn().mockResolvedValue({ state: "paused" as const }),
    };
    const service = new MusicService(
      { callService, listMediaPlayers: vi.fn() },
      "media_player.station",
      database,
      musicAssistant as never,
    );

    await service.resume();

    expect(callService).toHaveBeenCalledWith({
      domain: "media_player",
      service: "media_play",
      data: { entity_id: "media_player.station" },
    });
    database.close();
  });

  it("synchronizes SQLite current track with the actual Music Assistant title", () => {
    const database = new AppDatabase(":memory:");
    const old = database.enqueueMusicTrack("media_player.station", "owner", "Old Song");
    database.markMusicTrackPlaying(old.id);
    database.enqueueMusicTrack("media_player.station", "owner", "Она не вышла замуж...");

    const current = database.syncCurrentMusicTrack(
      "media_player.station",
      "Чиж & Co — Она не вышла замуж...",
    );

    expect(current?.query).toBe("Она не вышла замуж...");
    expect(database.getCurrentMusicTrack("media_player.station")?.query).toBe("Она не вышла замуж...");
    database.close();
  });
});
