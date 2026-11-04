import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessDeniedError, AccessService } from "../src/core/access.service.js";
import { AppDatabase } from "../src/db/database.js";

describe("access boundaries", () => {
  it("rejects an unknown Telegram user", () => {
    const access = new AccessService(12345);
    expect(() => access.authorize("99999")).toThrow(AccessDeniedError);
    expect(access.canExecute("12345")).toBe(true);
  });

  it("allows only a registered user explicitly approved by the owner", () => {
    const database = new AppDatabase(":memory:");
    const access = new AccessService(12345, database);
    database.registerBotUser("777", "friend", "Friend");
    expect(access.canExecute("777")).toBe(false);
    database.setBotUserAuthorized("777", true);
    expect(access.canExecute("777")).toBe(true);
    database.setBotUserAuthorized("777", false);
    expect(access.canExecute("777")).toBe(false);
    database.close();
  });

  it("finds a user by username without case sensitivity", () => {
    const database = new AppDatabase(":memory:");
    database.registerBotUser("777", "SomeUser", "Some User");
    expect(database.findBotUserByUsername("@someuser")?.telegramId).toBe("777");
    database.close();
  });

  it("stores one pending request and allows the owner to approve it", () => {
    const database = new AppDatabase(":memory:");
    database.registerBotUser("777", "friend", "Friend");
    expect(database.createAccessRequest("777").created).toBe(true);
    expect(database.createAccessRequest("777").created).toBe(false);
    expect(database.countPendingAccessRequests()).toBe(1);

    const request = database.listPendingAccessRequests()[0]!;
    const resolved = database.resolveAccessRequest(request.id, "APPROVED", "12345");
    expect(resolved?.status).toBe("APPROVED");
    expect(database.isBotUserAuthorized("777")).toBe(true);
    expect(database.countPendingAccessRequests()).toBe(0);
    database.close();
  });

  it("keeps rejected requests in history and permits a new request", () => {
    const database = new AppDatabase(":memory:");
    database.registerBotUser("777", undefined, "Friend");
    const first = database.createAccessRequest("777").request;
    database.resolveAccessRequest(first.id, "REJECTED", "12345");
    const second = database.createAccessRequest("777");
    expect(second.created).toBe(true);
    expect(second.request.id).not.toBe(first.id);
    expect(database.countPendingAccessRequests()).toBe(1);
    database.close();
  });
});

describe("callback ownership and expiry", () => {
  const databases: AppDatabase[] = [];
  afterEach(() => {
    vi.useRealTimers();
    databases.splice(0).forEach((database) => database.close());
  });

  it("does not let another user consume a callback", () => {
    const database = new AppDatabase(":memory:");
    databases.push(database);
    const id = database.createCallback("owner", { kind: "home" }, 300);
    expect(database.consumeCallback(id, "attacker")).toBeUndefined();
    expect(database.consumeCallback(id, "owner")).toEqual({ kind: "home" });
    expect(database.consumeCallback(id, "owner")).toBeUndefined();
  });

  it("rejects an expired callback", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
    const database = new AppDatabase(":memory:");
    databases.push(database);
    const id = database.createCallback("owner", { kind: "home" }, 30);
    vi.setSystemTime(new Date("2026-10-31T12:00:31Z"));
    expect(database.consumeCallback(id, "owner")).toBeUndefined();
  });
});
