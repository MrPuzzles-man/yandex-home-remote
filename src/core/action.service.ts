import type { AppDatabase } from "../db/database.js";
import type { ActionResult, Capability, DeviceCommand, JsonObject } from "../domain/models.js";
import type { YandexIotGateway } from "../integrations/yandex-iot.client.js";
import { AccessService } from "./access.service.js";
import { CatalogService } from "./catalog.service.js";

export class ActionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionValidationError";
  }
}

const BLOCKED_DEVICE_TYPES = new Set([
  "devices.types.lock",
  "devices.types.security_system",
]);

export class ActionService {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly gateway: YandexIotGateway | undefined,
    private readonly catalog: CatalogService,
    private readonly access: AccessService,
    private readonly database: AppDatabase,
  ) {}

  validateAction(command: DeviceCommand): Capability {
    this.access.authorize(command.actorId);
    const catalog = this.catalog.getCatalog();
    const device =
      command.targetType === "device"
        ? catalog.devices.find((item) => item.id === command.targetId)
        : undefined;
    const target = device ?? catalog.groups.find((item) => item.id === command.targetId);
    if (!target) throw new ActionValidationError("Устройство или группа не найдены");
    if (device && BLOCKED_DEVICE_TYPES.has(device.type)) {
      throw new ActionValidationError("Удалённое управление этим типом устройства запрещено");
    }
    if (device?.status === "offline") {
      throw new ActionValidationError("Устройство не в сети");
    }

    const supported = target.capabilities.find(
      (capability) =>
        capability.type === command.capabilityType &&
        getParameterInstance(capability) === command.instance,
    );
    if (!supported) throw new ActionValidationError("Устройство не поддерживает эту команду");
    validateValue(supported, command.value);
    return { ...supported, state: { instance: command.instance, value: command.value } };
  }

  executeAction(command: DeviceCommand): Promise<ActionResult> {
    const previous = this.queues.get(command.targetId) ?? Promise.resolve();
    const execution = previous.catch(() => undefined).then(async () => {
      if (!this.gateway) throw new ActionValidationError("Yandex IoT не настроен");
      const capability = this.validateAction(command);
      const result =
        command.targetType === "device"
          ? await this.gateway.executeDeviceAction(command.targetId, capability, command.requestId)
          : await this.gateway.executeGroupAction(command.targetId, capability, command.requestId);
      this.database.logAction(command, result);
      return result;
    });
    this.queues.set(command.targetId, execution);
    void execution.finally(() => {
      if (this.queues.get(command.targetId) === execution) this.queues.delete(command.targetId);
    });
    return execution;
  }

  async executeScenario(actorId: string, scenarioId: string, requestId: string): Promise<ActionResult> {
    this.access.authorize(actorId);
    if (!this.gateway) throw new ActionValidationError("Yandex IoT не настроен");
    if (!this.catalog.getCatalog().scenarios.some((scenario) => scenario.id === scenarioId)) {
      throw new ActionValidationError("Сценарий не найден");
    }
    return this.gateway.executeScenario(scenarioId, requestId);
  }
}

function getParameterInstance(capability: Capability): string | undefined {
  const instance = capability.parameters.instance;
  return typeof instance === "string" ? instance : capability.state?.instance;
}

function validateValue(capability: Capability, value: DeviceCommand["value"]): void {
  if (capability.type.endsWith("on_off") || capability.type.endsWith("toggle")) {
    if (typeof value !== "boolean") throw new ActionValidationError("Ожидалось логическое значение");
    return;
  }
  if (capability.type.endsWith("range")) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new ActionValidationError("Ожидалось числовое значение");
    }
    const range = capability.parameters.range as JsonObject | undefined;
    const min = range?.min;
    const max = range?.max;
    const precision = range?.precision;
    if (typeof min === "number" && value < min) throw new ActionValidationError(`Минимум: ${min}`);
    if (typeof max === "number" && value > max) throw new ActionValidationError(`Максимум: ${max}`);
    if (typeof precision === "number" && typeof min === "number") {
      const steps = (value - min) / precision;
      if (Math.abs(steps - Math.round(steps)) > 1e-8) {
        throw new ActionValidationError(`Значение должно изменяться с шагом ${precision}`);
      }
    }
    return;
  }
  if (capability.type.endsWith("mode")) {
    if (typeof value !== "string") throw new ActionValidationError("Ожидалось название режима");
    const modes = capability.parameters.modes;
    if (
      Array.isArray(modes) &&
      !modes.some((mode) => typeof mode === "object" && mode !== null && "value" in mode && mode.value === value)
    ) {
      throw new ActionValidationError("Режим не поддерживается");
    }
    return;
  }
  if (capability.type.endsWith("color_setting")) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ActionValidationError("Ожидались параметры цвета");
    }
    return;
  }
  throw new ActionValidationError(`Тип возможности пока не поддержан: ${capability.type}`);
}
