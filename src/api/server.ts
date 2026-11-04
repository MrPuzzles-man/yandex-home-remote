import Fastify, { type FastifyInstance } from "fastify";
import type { AccessService } from "../core/access.service.js";
import type { CatalogService } from "../core/catalog.service.js";
import type { MusicService } from "../core/music.service.js";

export function createApi(deps: {
  access: AccessService;
  catalog: CatalogService;
  music: MusicService;
  logLevel: string;
}): FastifyInstance {
  const app = Fastify({ logger: { level: deps.logLevel } });

  app.get("/health", async () => ({
    status: "ok",
    yandexIotConfigured: deps.catalog.isLiveConfigured(),
    accessConfigured: deps.access.isConfigured(),
    music: deps.music.getStatus(),
  }));

  app.get("/api/catalog", async (request, reply) => {
    const actorId = request.headers["x-telegram-user-id"];
    if (typeof actorId !== "string" || !deps.access.canExecute(actorId)) {
      return reply.code(403).send({ error: "FORBIDDEN" });
    }
    try {
      return deps.catalog.getCatalog();
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : "CATALOG_UNAVAILABLE" });
    }
  });

  return app;
}
