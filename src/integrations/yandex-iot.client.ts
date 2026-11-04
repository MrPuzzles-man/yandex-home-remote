import { randomUUID } from "node:crypto";
import type {
  ActionResult,
  Capability,
  Catalog,
  Device,
  Group,
  Household,
  Room,
  Scenario,
} from "../domain/models.js";

type YandexUserInfo = {
  status: string;
  request_id: string;
  households?: Household[];
  rooms?: Array<Room & { household_id?: string }>;
  devices?: Array<Device & { room_id?: string }>;
  groups?: Array<Group & { room_id?: string }>;
  scenarios?: Array<Scenario & { is_active?: boolean }>;
};

type YandexActionResponse = {
  status: string;
  request_id?: string;
  devices?: Array<{
    id: string;
    capabilities?: Array<{
      type: string;
      state?: { instance: string; action_result?: { status: string; error_code?: string; error_message?: string } };
    }>;
  }>;
};

export class YandexIotError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
    readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = "YandexIotError";
  }
}

export interface YandexIotGateway {
  getUserInfo(): Promise<Catalog>;
  getDevice(deviceId: string): Promise<Device>;
  executeDeviceAction(deviceId: string, capability: Capability, requestId: string): Promise<ActionResult>;
  executeGroupAction(groupId: string, capability: Capability, requestId: string): Promise<ActionResult>;
  executeScenario(scenarioId: string, requestId: string): Promise<ActionResult>;
}

export class YandexIotClient implements YandexIotGateway {
  constructor(
    private readonly token: string,
    private readonly baseUrl = "https://api.iot.yandex.net",
    private readonly timeoutMs = 10_000,
  ) {}

  async getUserInfo(): Promise<Catalog> {
    const body = await this.request<YandexUserInfo>("/v1.0/user/info");
    return {
      households: body.households ?? [],
      rooms: (body.rooms ?? []).map((room) => ({
        id: room.id,
        name: room.name,
        ...(room.household_id ? { householdId: room.household_id } : {}),
      })),
      devices: (body.devices ?? []).map(normalizeDevice),
      groups: (body.groups ?? []).map(normalizeGroup),
      scenarios: (body.scenarios ?? []).map((scenario) => ({
        id: scenario.id,
        name: scenario.name,
        ...(typeof scenario.is_active === "boolean" ? { isActive: scenario.is_active } : {}),
      })),
      syncedAt: new Date().toISOString(),
    };
  }

  async getDevice(deviceId: string): Promise<Device> {
    const body = await this.request<Device & { room_id?: string }>(
      `/v1.0/devices/${encodeURIComponent(deviceId)}`,
    );
    return normalizeDevice(body);
  }

  async executeDeviceAction(
    deviceId: string,
    capability: Capability,
    requestId: string,
  ): Promise<ActionResult> {
    const body = await this.request<YandexActionResponse>("/v1.0/devices/actions", {
      method: "POST",
      requestId,
      body: { devices: [{ id: deviceId, actions: [toAction(capability)] }] },
    });
    return parseActionResult(body, requestId);
  }

  async executeGroupAction(
    groupId: string,
    capability: Capability,
    requestId: string,
  ): Promise<ActionResult> {
    const body = await this.request<YandexActionResponse>(
      `/v1.0/groups/${encodeURIComponent(groupId)}/actions`,
      { method: "POST", requestId, body: { actions: [toAction(capability)] } },
    );
    return parseActionResult(body, requestId);
  }

  async executeScenario(scenarioId: string, requestId: string): Promise<ActionResult> {
    const body = await this.request<YandexActionResponse>(
      `/v1.0/scenarios/${encodeURIComponent(scenarioId)}/actions`,
      { method: "POST", requestId, body: {} },
    );
    return {
      status: body.status === "ok" ? "DONE" : "ERROR",
      requestId: body.request_id ?? requestId,
    };
  }

  private async request<T>(
    path: string,
    options: { method?: "GET" | "POST"; body?: unknown; requestId?: string } = {},
  ): Promise<T> {
    const requestId = options.requestId ?? randomUUID();
    let response: Response;
    try {
      response = await fetch(new URL(path, this.baseUrl), {
        method: options.method ?? "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "X-Request-Id": requestId,
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new YandexIotError(
        `Yandex IoT API недоступен: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      parsed = raw;
    }

    if (!response.ok) {
      throw new YandexIotError(
        `Yandex IoT API вернул HTTP ${response.status}`,
        response.status,
        parsed,
      );
    }
    return parsed as T;
  }
}

function normalizeDevice(device: Device & { room_id?: string }): Device {
  return {
    id: device.id,
    name: device.name,
    type: device.type,
    aliases: device.aliases ?? [],
    capabilities: device.capabilities ?? [],
    properties: device.properties ?? [],
    ...(device.room_id ? { roomId: device.room_id } : {}),
    ...(device.status ? { status: device.status } : {}),
  };
}

function normalizeGroup(group: Group & { room_id?: string }): Group {
  return {
    id: group.id,
    name: group.name,
    aliases: group.aliases ?? [],
    capabilities: group.capabilities ?? [],
    ...(group.room_id ? { roomId: group.room_id } : {}),
  };
}

function toAction(capability: Capability): object {
  if (!capability.state) throw new Error("Для действия требуется state");
  return {
    type: capability.type,
    state: { instance: capability.state.instance, value: capability.state.value },
  };
}

function parseActionResult(body: YandexActionResponse, fallbackRequestId: string): ActionResult {
  const result = body.devices?.[0]?.capabilities?.[0]?.state?.action_result;
  if (!result) {
    return {
      status: body.status === "ok" ? "DONE" : "ERROR",
      requestId: body.request_id ?? fallbackRequestId,
    };
  }
  return {
    status: result.status === "DONE" ? "DONE" : "ERROR",
    requestId: body.request_id ?? fallbackRequestId,
    ...(result.error_code ? { errorCode: result.error_code } : {}),
    ...(result.error_message ? { errorMessage: result.error_message } : {}),
  };
}
