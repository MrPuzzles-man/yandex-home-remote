import { afterEach, describe, expect, it, vi } from "vitest";
import { YandexIotClient, YandexIotError } from "../src/integrations/yandex-iot.client.js";

describe("YandexIotClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the user API and normalizes room identifiers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "ok",
          request_id: "r1",
          households: [],
          rooms: [{ id: "room-1", name: "Спальня", household_id: "home-1" }],
          devices: [
            {
              id: "device-1",
              name: "Лампа",
              type: "devices.types.light",
              room_id: "room-1",
              capabilities: [],
              properties: [],
              aliases: [],
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new YandexIotClient("secret", "https://api.iot.yandex.net");
    const result = await client.getUserInfo();

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://api.iot.yandex.net/v1.0/user/info"),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer secret" }) }),
    );
    expect(result.rooms[0]).toMatchObject({ householdId: "home-1" });
    expect(result.devices[0]).toMatchObject({ roomId: "room-1" });
  });

  it("surfaces API failures without exposing the token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "error" }), { status: 401 })),
    );
    const client = new YandexIotClient("super-secret-token");
    await expect(client.getUserInfo()).rejects.toBeInstanceOf(YandexIotError);
    await expect(client.getUserInfo()).rejects.not.toThrow("super-secret-token");
  });
});
