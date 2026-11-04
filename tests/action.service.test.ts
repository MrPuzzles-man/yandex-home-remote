import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { AccessService } from "../src/core/access.service.js";
import { ActionService, ActionValidationError } from "../src/core/action.service.js";
import { CatalogService } from "../src/core/catalog.service.js";
import { AppDatabase } from "../src/db/database.js";
import type { Capability, Catalog } from "../src/domain/models.js";
import type { YandexIotGateway } from "../src/integrations/yandex-iot.client.js";

function catalog(): Catalog {
  return {
    households: [],
    rooms: [],
    groups: [],
    scenarios: [],
    syncedAt: new Date().toISOString(),
    devices: [
      {
        id: "lamp-1",
        name: "Лампа",
        type: "devices.types.light",
        aliases: [],
        properties: [],
        capabilities: [
          {
            type: "devices.capabilities.range",
            retrievable: true,
            reportable: true,
            parameters: { instance: "brightness", range: { min: 0, max: 100, precision: 5 } },
          },
        ],
      },
    ],
  };
}

function command(value: number) {
  return {
    actorId: "42",
    targetId: "lamp-1",
    targetType: "device" as const,
    capabilityType: "devices.capabilities.range",
    instance: "brightness",
    value,
    requestId: randomUUID(),
  };
}

describe("ActionService", () => {
  const databases: AppDatabase[] = [];
  afterEach(() => databases.splice(0).forEach((database) => database.close()));

  it("rejects a value outside capability constraints", () => {
    const database = new AppDatabase(":memory:");
    databases.push(database);
    database.saveCatalog(catalog());
    const gateway = {} as YandexIotGateway;
    const service = new ActionService(
      gateway,
      new CatalogService(gateway, database),
      new AccessService(42),
      database,
    );
    expect(() => service.validateAction(command(103))).toThrow(ActionValidationError);
    expect(() => service.validateAction(command(52))).toThrow("шагом 5");
  });

  it("serializes simultaneous commands for the same device", async () => {
    const database = new AppDatabase(":memory:");
    databases.push(database);
    database.saveCatalog(catalog());
    const starts: number[] = [];
    const releases: Array<() => void> = [];
    const gateway = {
      executeDeviceAction: async (_id: string, capability: Capability) => {
        starts.push(capability.state?.value as number);
        await new Promise<void>((resolve) => releases.push(resolve));
        return { status: "DONE" as const, requestId: randomUUID() };
      },
    } as unknown as YandexIotGateway;
    const service = new ActionService(
      gateway,
      new CatalogService(gateway, database),
      new AccessService(42),
      database,
    );

    const first = service.executeAction(command(10));
    const second = service.executeAction(command(20));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(starts).toEqual([10]);
    releases[0]?.();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(starts).toEqual([10, 20]);
    releases[1]?.();
    await second;
  });
});
