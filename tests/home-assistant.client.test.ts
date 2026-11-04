import { describe, expect, it, vi } from "vitest";
import { HomeAssistantClient } from "../src/integrations/home-assistant.client.js";

describe("HomeAssistantClient", () => {
  it("retries transient 500 responses", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }))
      .mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }))
      .mockResolvedValueOnce(new Response("[]", { status: 200 }));
    const client = new HomeAssistantClient("http://homeassistant:8123", "token", fetcher, 0);

    await client.callService({ domain: "media_player", service: "play_media", data: {} });

    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
