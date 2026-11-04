import { describe, expect, it } from "vitest";
import { maxVolumeForRole, validateVolumeForRole } from "../src/core/volume-policy.js";

describe("volume access policy", () => {
  it("shows the owner levels up to 10 and regular users only up to 6", () => {
    expect(maxVolumeForRole(true)).toBe(10);
    expect(maxVolumeForRole(false)).toBe(6);
  });

  it("blocks a regular user from bypassing the UI limit", () => {
    expect(() => validateVolumeForRole(6, false)).not.toThrow();
    expect(() => validateVolumeForRole(7, false)).toThrow("от 1 до 6");
    expect(() => validateVolumeForRole(0, false)).toThrow("от 1 до 6");
  });

  it("keeps the full existing range for the owner", () => {
    expect(() => validateVolumeForRole(10, true)).not.toThrow();
    expect(() => validateVolumeForRole(0, true)).not.toThrow();
    expect(() => validateVolumeForRole(11, true)).toThrow("от 0 до 10");
  });
});
