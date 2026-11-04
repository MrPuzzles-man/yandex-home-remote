import { describe, expect, it } from "vitest";
import { canUseBotCallback } from "../src/core/music-access-policy.js";

describe("regular user music access", () => {
  it.each(["home", "music", "music_prompt", "music_queue", "music_speak", "music_volume"])(
    "allows %s",
    (kind) => expect(canUseBotCallback(kind, false)).toBe(true),
  );

  it.each(["music_transport", "music_next", "music_clear_queue", "stations", "scenario"])(
    "blocks %s",
    (kind) => expect(canUseBotCallback(kind, false)).toBe(false),
  );

  it("keeps every callback available to the owner", () => {
    expect(canUseBotCallback("music_transport", true)).toBe(true);
    expect(canUseBotCallback("scenario", true)).toBe(true);
  });
});
