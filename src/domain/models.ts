export type JsonObject = Record<string, unknown>;

export type CapabilityState = {
  instance: string;
  value: unknown;
};

export type Capability = {
  type: string;
  retrievable: boolean;
  reportable: boolean;
  parameters: JsonObject;
  state?: CapabilityState;
};

export type Property = {
  type: string;
  retrievable: boolean;
  reportable: boolean;
  parameters: JsonObject;
  state?: CapabilityState;
};

export type Device = {
  id: string;
  name: string;
  type: string;
  roomId?: string;
  aliases: string[];
  capabilities: Capability[];
  properties: Property[];
  status?: string;
};

export type Group = {
  id: string;
  name: string;
  roomId?: string;
  aliases: string[];
  capabilities: Capability[];
};

export type Scenario = { id: string; name: string; isActive?: boolean };
export type Room = { id: string; name: string; householdId?: string };
export type Household = { id: string; name: string };

export type Catalog = {
  households: Household[];
  rooms: Room[];
  devices: Device[];
  groups: Group[];
  scenarios: Scenario[];
  syncedAt: string;
};

export type DeviceCommand = {
  actorId: string;
  targetId: string;
  targetType: "device" | "group";
  capabilityType: string;
  instance: string;
  value: boolean | number | string | JsonObject;
  requestId: string;
};

export type ActionResult = {
  status: "DONE" | "ERROR";
  requestId: string;
  errorCode?: string;
  errorMessage?: string;
};

export const DEVICE_CATEGORIES: Record<string, string> = {
  "devices.types.light": "Свет",
  "devices.types.socket": "Розетки",
  "devices.types.thermostat": "Климат",
  "devices.types.thermostat.ac": "Климат",
  "devices.types.humidifier": "Климат",
  "devices.types.purifier": "Климат",
  "devices.types.sensor": "Датчики",
  "devices.types.smart_speaker": "Колонки",
};

export function categoryFor(device: Device): string {
  const exact = DEVICE_CATEGORIES[device.type];
  if (exact) return exact;
  const parent = Object.entries(DEVICE_CATEGORIES).find(([type]) => device.type.startsWith(`${type}.`));
  return parent?.[1] ?? "Другие устройства";
}
