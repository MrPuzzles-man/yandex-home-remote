export class AccessDeniedError extends Error {
  constructor(message = "Доступ запрещён") {
    super(message);
    this.name = "AccessDeniedError";
  }
}

export class AccessService {
  constructor(
    private readonly ownerTelegramId?: number,
    private readonly database?: AppDatabase,
  ) {}

  isConfigured(): boolean {
    return this.ownerTelegramId !== undefined;
  }

  authorize(actorId: string): void {
    if (!this.canExecute(actorId)) {
      throw new AccessDeniedError();
    }
  }

  canExecute(actorId: string): boolean {
    return this.isOwner(actorId) || Boolean(this.database?.isBotUserAuthorized(actorId));
  }

  isOwner(actorId: string): boolean {
    return this.ownerTelegramId !== undefined && actorId === String(this.ownerTelegramId);
  }
}
import type { AppDatabase } from "../db/database.js";

