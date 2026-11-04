import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import type { ActionResult, Catalog, DeviceCommand } from "../domain/models.js";

export type CallbackPayload =
  | { kind: "category"; category: string }
  | { kind: "device"; deviceId: string }
  | { kind: "action"; command: Omit<DeviceCommand, "actorId" | "requestId"> }
  | { kind: "scenario"; scenarioId: string }
  | { kind: "devices" }
  | { kind: "device_status" }
  | { kind: "scenarios" }
  | { kind: "custom_scenarios" }
  | { kind: "basic_scenarios" }
  | { kind: "basic_action"; action: "weather" | "news" | "my_wave" | "favorites" | "morning_show" }
  | { kind: "alarms" }
  | { kind: "alarm_new" }
  | { kind: "alarm_frequency"; frequency: "once" | "daily" | "weekdays" | "weekends" }
  | { kind: "alarm_status" }
  | { kind: "alarm_disable_all" }
  | { kind: "alarm_enable_all" }
  | { kind: "alarm_music" }
  | { kind: "alarm_standard_sound" }
  | { kind: "stations" }
  | { kind: "station_select"; entityId: string }
  | { kind: "music" }
  | { kind: "music_prompt" }
  | { kind: "music_speak" }
  | { kind: "music_queue" }
  | { kind: "music_next" }
  | { kind: "music_clear_queue" }
  | { kind: "music_volume"; level: number }
  | { kind: "music_transport"; action: "play" | "pause" }
  | { kind: "admin" }
  | { kind: "admin_prompt" }
  | { kind: "admin_requests" }
  | { kind: "admin_approve_request"; requestId: number }
  | { kind: "admin_reject_request"; requestId: number }
  | { kind: "admin_revoke"; telegramId: string }
  | { kind: "home" };

export type BotUser = {
  telegramId: string;
  username?: string;
  displayName: string;
  authorized: boolean;
};

export type AccessRequest = {
  id: number;
  user: BotUser;
  status: "PENDING" | "APPROVED" | "REJECTED";
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
};

export type MusicQueueItem = {
  id: number;
  stationEntityId: string;
  requestedBy: string;
  query: string;
  status: "QUEUED" | "PLAYING" | "DONE" | "FAILED" | "CLEARED";
  createdAt: string;
  startedAt?: string;
};

export class AppDatabase {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  saveCatalog(catalog: Catalog): void {
    this.db
      .prepare(
        `INSERT INTO app_state(key, value, updated_at) VALUES('catalog', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      )
      .run(JSON.stringify(catalog), catalog.syncedAt);
  }

  loadCatalog(): Catalog | undefined {
    const row = this.db.prepare("SELECT value FROM app_state WHERE key='catalog'").get() as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as Catalog) : undefined;
  }

  createCallback(actorId: string, payload: CallbackPayload, ttlSeconds: number): string {
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 24);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    this.db
      .prepare("INSERT INTO bot_callbacks(id, actor_id, payload, expires_at) VALUES(?, ?, ?, ?)")
      .run(id, actorId, JSON.stringify(payload), expiresAt);
    return id;
  }

  consumeCallback(id: string, actorId: string): CallbackPayload | undefined {
    const transaction = this.db.transaction(() => {
      const row = this.db
        .prepare("SELECT actor_id, payload, expires_at FROM bot_callbacks WHERE id=?")
        .get(id) as { actor_id: string; payload: string; expires_at: string } | undefined;
      if (!row || row.actor_id !== actorId || Date.parse(row.expires_at) <= Date.now()) return undefined;
      this.db.prepare("DELETE FROM bot_callbacks WHERE id=?").run(id);
      return JSON.parse(row.payload) as CallbackPayload;
    });
    return transaction();
  }

  registerBotUser(telegramId: string, username: string | undefined, displayName: string): void {
    const normalized = username?.replace(/^@/, "").trim() || null;
    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      if (normalized) {
        this.db.prepare("UPDATE bot_users SET username=NULL WHERE username=? COLLATE NOCASE AND telegram_id<>?")
          .run(normalized, telegramId);
      }
      this.db.prepare(
        `INSERT INTO bot_users(telegram_id, username, display_name, authorized, updated_at)
         VALUES(?, ?, ?, 0, ?)
         ON CONFLICT(telegram_id) DO UPDATE SET
           username=excluded.username, display_name=excluded.display_name, updated_at=excluded.updated_at`,
      ).run(telegramId, normalized, displayName, now);
    });
    transaction();
  }

  isBotUserAuthorized(telegramId: string): boolean {
    const row = this.db.prepare("SELECT authorized FROM bot_users WHERE telegram_id=?").get(telegramId) as
      | { authorized: number }
      | undefined;
    return row?.authorized === 1;
  }

  findBotUserByUsername(username: string): BotUser | undefined {
    const normalized = username.replace(/^@/, "").trim();
    const row = this.db.prepare(
      "SELECT telegram_id, username, display_name, authorized FROM bot_users WHERE username=? COLLATE NOCASE",
    ).get(normalized) as
      | { telegram_id: string; username: string | null; display_name: string; authorized: number }
      | undefined;
    return row ? mapBotUser(row) : undefined;
  }

  listAuthorizedBotUsers(): BotUser[] {
    const rows = this.db.prepare(
      "SELECT telegram_id, username, display_name, authorized FROM bot_users WHERE authorized=1 ORDER BY display_name",
    ).all() as Array<{ telegram_id: string; username: string | null; display_name: string; authorized: number }>;
    return rows.map(mapBotUser);
  }

  setBotUserAuthorized(telegramId: string, authorized: boolean): boolean {
    return this.db.prepare("UPDATE bot_users SET authorized=? WHERE telegram_id=?")
      .run(authorized ? 1 : 0, telegramId).changes === 1;
  }

  createAccessRequest(telegramId: string): { request: AccessRequest; created: boolean } {
    return this.db.transaction(() => {
      const existing = this.getPendingAccessRequest(telegramId);
      if (existing) return { request: existing, created: false };
      const result = this.db.prepare(
        `INSERT INTO access_requests(telegram_id, status, created_at)
         VALUES(?, 'PENDING', ?)`,
      ).run(telegramId, new Date().toISOString());
      return { request: this.getAccessRequest(Number(result.lastInsertRowid))!, created: true };
    })();
  }

  listPendingAccessRequests(): AccessRequest[] {
    const rows = this.db.prepare(
      `${ACCESS_REQUEST_SELECT}
       WHERE request.status='PENDING'
       ORDER BY request.created_at`,
    ).all() as AccessRequestRow[];
    return rows.map(mapAccessRequest);
  }

  countPendingAccessRequests(): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM access_requests WHERE status='PENDING'",
    ).get() as { count: number };
    return row.count;
  }

  resolveAccessRequest(
    requestId: number,
    decision: "APPROVED" | "REJECTED",
    decidedBy: string,
  ): AccessRequest | undefined {
    return this.db.transaction(() => {
      const request = this.getAccessRequest(requestId);
      if (!request || request.status !== "PENDING") return undefined;
      const now = new Date().toISOString();
      this.db.prepare(
        `UPDATE access_requests
         SET status=?, decided_at=?, decided_by=?
         WHERE id=? AND status='PENDING'`,
      ).run(decision, now, decidedBy, requestId);
      if (decision === "APPROVED") this.setBotUserAuthorized(request.user.telegramId, true);
      return this.getAccessRequest(requestId);
    })();
  }

  approvePendingAccessRequestsForUser(telegramId: string, decidedBy: string): number {
    return this.db.prepare(
      `UPDATE access_requests
       SET status='APPROVED', decided_at=?, decided_by=?
       WHERE telegram_id=? AND status='PENDING'`,
    ).run(new Date().toISOString(), decidedBy, telegramId).changes;
  }

  enqueueMusicTrack(stationEntityId: string, requestedBy: string, query: string): MusicQueueItem {
    const createdAt = new Date().toISOString();
    const result = this.db.prepare(
      `INSERT INTO music_queue(station_entity_id, requested_by, query, status, created_at)
       VALUES(?, ?, ?, 'QUEUED', ?)`,
    ).run(stationEntityId, requestedBy, query, createdAt);
    return this.getMusicQueueItem(Number(result.lastInsertRowid))!;
  }

  getCurrentMusicTrack(stationEntityId: string): MusicQueueItem | undefined {
    const row = this.db.prepare(
      `SELECT * FROM music_queue WHERE station_entity_id=? AND status='PLAYING'
       ORDER BY id LIMIT 1`,
    ).get(stationEntityId) as MusicQueueRow | undefined;
    return row ? mapMusicQueueItem(row) : undefined;
  }

  syncCurrentMusicTrack(stationEntityId: string, actualTitle: string | undefined): MusicQueueItem | undefined {
    return this.db.transaction(() => {
      const active = this.db.prepare(
        `SELECT * FROM music_queue
         WHERE station_entity_id=? AND status IN ('PLAYING','QUEUED') ORDER BY id DESC`,
      ).all(stationEntityId) as MusicQueueRow[];
      const normalizedActual = actualTitle ? normalizeTrackName(actualTitle) : "";
      if (!normalizedActual) return this.getCurrentMusicTrack(stationEntityId);
      const matched = normalizedActual
        ? active.find((row) => {
            const query = normalizeTrackName(row.query);
            return query.length >= 4 && (normalizedActual.includes(query) || query.includes(normalizedActual));
          })
        : undefined;

      this.db.prepare(
        `UPDATE music_queue SET status='DONE', finished_at=?
         WHERE station_entity_id=? AND status='PLAYING' AND id<>?`,
      ).run(new Date().toISOString(), stationEntityId, matched?.id ?? -1);
      if (!matched) return undefined;
      this.db.prepare(
        `UPDATE music_queue SET status='PLAYING', started_at=COALESCE(started_at, ?), finished_at=NULL
         WHERE id=?`,
      ).run(new Date().toISOString(), matched.id);
      return this.getMusicQueueItem(matched.id);
    })();
  }

  listPendingMusicTracks(stationEntityId: string): MusicQueueItem[] {
    const rows = this.db.prepare(
      `SELECT * FROM music_queue WHERE station_entity_id=? AND status='QUEUED'
       ORDER BY id`,
    ).all(stationEntityId) as MusicQueueRow[];
    return rows.map(mapMusicQueueItem);
  }

  getMusicQueuePosition(stationEntityId: string, itemId: number): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS count FROM music_queue
       WHERE station_entity_id=? AND status IN ('PLAYING','QUEUED') AND id<=?`,
    ).get(stationEntityId, itemId) as { count: number };
    return row.count;
  }

  markMusicTrackPlaying(itemId: number): MusicQueueItem | undefined {
    this.db.prepare(
      `UPDATE music_queue SET status='PLAYING', started_at=? WHERE id=? AND status='QUEUED'`,
    ).run(new Date().toISOString(), itemId);
    return this.getMusicQueueItem(itemId);
  }

  markMusicTrackFailed(itemId: number): void {
    this.db.prepare("UPDATE music_queue SET status='FAILED', finished_at=? WHERE id=?")
      .run(new Date().toISOString(), itemId);
  }

  advanceMusicQueue(stationEntityId: string): MusicQueueItem | undefined {
    return this.db.transaction(() => {
      this.db.prepare(
        `UPDATE music_queue SET status='DONE', finished_at=?
         WHERE station_entity_id=? AND status='PLAYING'`,
      ).run(new Date().toISOString(), stationEntityId);
      const next = this.db.prepare(
        `SELECT * FROM music_queue WHERE station_entity_id=? AND status='QUEUED' ORDER BY id LIMIT 1`,
      ).get(stationEntityId) as MusicQueueRow | undefined;
      return next ? this.markMusicTrackPlaying(next.id) : undefined;
    })();
  }

  clearPendingMusicQueue(stationEntityId: string): number {
    return this.db.prepare(
      `UPDATE music_queue SET status='CLEARED', finished_at=?
       WHERE station_entity_id=? AND status='QUEUED'`,
    ).run(new Date().toISOString(), stationEntityId).changes;
  }

  clearActiveMusicQueue(stationEntityId: string): number {
    return this.db.prepare(
      `UPDATE music_queue SET status='CLEARED', finished_at=?
       WHERE station_entity_id=? AND status IN ('PLAYING','QUEUED')`,
    ).run(new Date().toISOString(), stationEntityId).changes;
  }

  private getMusicQueueItem(id: number): MusicQueueItem | undefined {
    const row = this.db.prepare("SELECT * FROM music_queue WHERE id=?").get(id) as MusicQueueRow | undefined;
    return row ? mapMusicQueueItem(row) : undefined;
  }

  private getPendingAccessRequest(telegramId: string): AccessRequest | undefined {
    const row = this.db.prepare(
      `${ACCESS_REQUEST_SELECT}
       WHERE request.telegram_id=? AND request.status='PENDING'
       ORDER BY request.id DESC LIMIT 1`,
    ).get(telegramId) as AccessRequestRow | undefined;
    return row ? mapAccessRequest(row) : undefined;
  }

  private getAccessRequest(id: number): AccessRequest | undefined {
    const row = this.db.prepare(
      `${ACCESS_REQUEST_SELECT} WHERE request.id=?`,
    ).get(id) as AccessRequestRow | undefined;
    return row ? mapAccessRequest(row) : undefined;
  }

  logAction(command: DeviceCommand, result: ActionResult): void {
    this.db
      .prepare(
        `INSERT INTO action_log(request_id, actor_id, target_id, target_type, capability_type,
         instance, value, status, error_code, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        command.requestId,
        command.actorId,
        command.targetId,
        command.targetType,
        command.capabilityType,
        command.instance,
        JSON.stringify(command.value),
        result.status,
        result.errorCode ?? null,
        new Date().toISOString(),
      );
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bot_callbacks (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_callbacks_expiry ON bot_callbacks(expires_at);
      CREATE TABLE IF NOT EXISTS action_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL UNIQUE,
        actor_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        target_type TEXT NOT NULL,
        capability_type TEXT NOT NULL,
        instance TEXT NOT NULL,
        value TEXT NOT NULL,
        status TEXT NOT NULL,
        error_code TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bot_users (
        telegram_id TEXT PRIMARY KEY,
        username TEXT,
        display_name TEXT NOT NULL,
        authorized INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bot_users_username ON bot_users(username COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS access_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('PENDING','APPROVED','REJECTED')),
        created_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        FOREIGN KEY(telegram_id) REFERENCES bot_users(telegram_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_access_requests_one_pending
        ON access_requests(telegram_id) WHERE status='PENDING';
      CREATE INDEX IF NOT EXISTS idx_access_requests_status_created
        ON access_requests(status, created_at);
      CREATE TABLE IF NOT EXISTS music_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        station_entity_id TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        query TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('QUEUED','PLAYING','DONE','FAILED','CLEARED')),
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_music_queue_station_status
        ON music_queue(station_entity_id, status, id);
    `);
  }
}

const ACCESS_REQUEST_SELECT = `
  SELECT request.id, request.telegram_id, request.status, request.created_at,
         request.decided_at, request.decided_by,
         user.username, user.display_name, user.authorized
  FROM access_requests request
  JOIN bot_users user ON user.telegram_id=request.telegram_id`;

type AccessRequestRow = {
  id: number;
  telegram_id: string;
  status: AccessRequest["status"];
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  username: string | null;
  display_name: string;
  authorized: number;
};

function mapAccessRequest(row: AccessRequestRow): AccessRequest {
  return {
    id: row.id,
    user: mapBotUser(row),
    status: row.status,
    createdAt: row.created_at,
    ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
    ...(row.decided_by ? { decidedBy: row.decided_by } : {}),
  };
}

type MusicQueueRow = {
  id: number;
  station_entity_id: string;
  requested_by: string;
  query: string;
  status: MusicQueueItem["status"];
  created_at: string;
  started_at: string | null;
};

function mapMusicQueueItem(row: MusicQueueRow): MusicQueueItem {
  return {
    id: row.id,
    stationEntityId: row.station_entity_id,
    requestedBy: row.requested_by,
    query: row.query,
    status: row.status,
    createdAt: row.created_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
  };
}

function mapBotUser(row: {
  telegram_id: string;
  username: string | null;
  display_name: string;
  authorized: number;
}): BotUser {
  return {
    telegramId: row.telegram_id,
    ...(row.username ? { username: row.username } : {}),
    displayName: row.display_name,
    authorized: row.authorized === 1,
  };
}

function normalizeTrackName(value: string): string {
  return value
    .toLocaleLowerCase("ru-RU")
    .replace(/[^a-zа-яё0-9]+/giu, " ")
    .trim();
}
