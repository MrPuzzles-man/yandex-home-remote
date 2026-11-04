import type { AppDatabase } from "../db/database.js";
import { categoryFor, type Catalog, type Device } from "../domain/models.js";
import type { YandexIotGateway } from "../integrations/yandex-iot.client.js";

export class CatalogUnavailableError extends Error {
  constructor() {
    super("Каталог ещё не загружен. Проверьте YANDEX_IOT_TOKEN и выполните синхронизацию.");
    this.name = "CatalogUnavailableError";
  }
}

export class CatalogService {
  private catalog: Catalog | undefined;

  constructor(
    private readonly gateway: YandexIotGateway | undefined,
    private readonly database: AppDatabase,
  ) {
    this.catalog = database.loadCatalog();
  }

  isLiveConfigured(): boolean {
    return this.gateway !== undefined;
  }

  async syncCatalog(): Promise<Catalog> {
    if (!this.gateway) throw new CatalogUnavailableError();
    const catalog = await this.gateway.getUserInfo();
    this.catalog = catalog;
    this.database.saveCatalog(catalog);
    return catalog;
  }

  getCatalog(): Catalog {
    if (!this.catalog) throw new CatalogUnavailableError();
    return this.catalog;
  }

  listCategories(): Array<{ name: string; count: number }> {
    const counts = new Map<string, number>();
    for (const device of this.getCatalog().devices) {
      const category = categoryFor(device);
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => left.name.localeCompare(right.name, "ru"));
  }

  listDevices(category?: string): Device[] {
    const devices = this.getCatalog().devices;
    return (category ? devices.filter((device) => categoryFor(device) === category) : devices).toSorted(
      (left, right) => left.name.localeCompare(right.name, "ru"),
    );
  }

  getDevice(deviceId: string): Device | undefined {
    return this.getCatalog().devices.find((device) => device.id === deviceId);
  }

  async refreshDevice(deviceId: string): Promise<Device> {
    if (!this.gateway) throw new CatalogUnavailableError();
    const device = await this.gateway.getDevice(deviceId);
    if (this.catalog) {
      const index = this.catalog.devices.findIndex((candidate) => candidate.id === deviceId);
      if (index >= 0) this.catalog.devices[index] = device;
      this.catalog.syncedAt = new Date().toISOString();
      this.database.saveCatalog(this.catalog);
    }
    return device;
  }
}
