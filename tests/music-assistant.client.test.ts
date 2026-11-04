import { describe, expect, it, vi } from "vitest";
import { MusicAssistantClient } from "../src/integrations/music-assistant.client.js";

describe("MusicAssistantClient", () => {
  it("searches a track and starts a new authoritative queue", async () => {
    const payloads: unknown[] = [
      { tracks: [{ uri: "ym://track/1", name: "Song", artists: [{ name: "Artist" }] }] },
      { state: "idle", current_index: null, ended: false },
      [],
      { state: "idle", current_media: null },
      null,
      { state: "playing", current_index: 0, ended: false },
      [{ uri: "ym://track/1", name: "Song", media_item: { uri: "ym://track/1", name: "Song", artists: [{ name: "Artist" }] } }],
      { state: "playing", current_media: { uri: "ym://track/1", title: "Song", artist: "Artist" } },
    ];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(JSON.stringify(payloads.shift()), { status: 200 }),
    );
    const client = new MusicAssistantClient("http://music-assistant:8095", "token", "player", fetcher);

    await expect(client.enqueue("Artist Song")).resolves.toEqual({
      track: { uri: "ym://track/1", title: "Artist — Song" },
      position: 1,
      started: true,
    });
    const playCall = JSON.parse(String(fetcher.mock.calls[4]?.[1]?.body)) as { args: { option: string } };
    expect(playCall.args.option).toBe("replace");
  });

  it("resumes the player when the SQLite preference matches actual media", async () => {
    const payloads: unknown[] = [
      { tracks: [{ uri: "ym://track/1", name: "Song", artists: [{ name: "Artist" }] }] },
      { state: "paused", current_media: { uri: "ym://track/1", title: "Song", artist: "Artist" } },
      null,
    ];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(JSON.stringify(payloads.shift()), { status: 200 }),
    );
    const client = new MusicAssistantClient("http://music-assistant:8095", "token", "player", fetcher);

    await client.playPreferred("Artist Song");

    const command = JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body)) as { command: string };
    expect(command.command).toBe("players/cmd/play");
  });

  it("replaces actual media when SQLite points to a different track", async () => {
    const payloads: unknown[] = [
      { tracks: [{ uri: "ym://track/1", name: "Wanted", artists: [{ name: "Artist" }] }] },
      { state: "playing", current_media: { uri: "ym://track/2", title: "Other", artist: "Other" } },
      null,
    ];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(JSON.stringify(payloads.shift()), { status: 200 }),
    );
    const client = new MusicAssistantClient("http://music-assistant:8095", "token", "player", fetcher);

    await client.playPreferred("Artist Wanted");

    const request = JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body)) as {
      command: string;
      args: { option: string; media: string };
    };
    expect(request).toMatchObject({
      command: "player_queues/play_media",
      args: { option: "replace", media: "ym://track/1" },
    });
  });
});
