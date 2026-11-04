import { describe, expect, it } from "vitest";
import { categoryFor, type Device } from "../src/domain/models.js";

describe("device categories", () => {
  it("classifies a concrete Yandex Station subtype as a speaker", () => {
    const station = {
      id: "station-1",
      name: "Пятница",
      type: "devices.types.smart_speaker.yandex.station.mini_2_no_clock",
      aliases: [],
      capabilities: [],
      properties: [],
    } satisfies Device;
    expect(categoryFor(station)).toBe("Колонки");
  });
});
