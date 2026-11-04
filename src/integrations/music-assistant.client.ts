export type MusicAssistantQueueItem = {
  uri: string;
  title: string;
};

export type MusicAssistantQueue = {
  state: string;
  current?: MusicAssistantQueueItem;
  pending: MusicAssistantQueueItem[];
};

export type MusicAssistantPlayback = {
  state: string;
  current?: MusicAssistantQueueItem;
};

type SearchTrack = {
  uri: string;
  name: string;
  artists?: Array<{ name?: string }>;
};

type PlayerQueue = {
  state?: string;
  current_index?: number | null;
  ended?: boolean;
};

type QueueItem = {
  uri?: string;
  name?: string;
  media_item?: SearchTrack;
};

type Player = {
  state?: string;
  current_media?: {
    uri?: string;
    title?: string;
    artist?: string;
  } | null;
};

export class MusicAssistantClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly playerId: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async enqueue(searchQuery: string): Promise<{ track: MusicAssistantQueueItem; position: number; started: boolean }> {
    const track = await this.searchTrack(searchQuery);
    const before = await this.getQueue();
    const started = !before.current && before.pending.length === 0;
    await this.rpc("player_queues/play_media", {
      queue_id: this.playerId,
      media: track.uri,
      option: started ? "replace" : "add",
    });
    const after = await this.getQueue();
    const sequence = [...(after.current ? [after.current] : []), ...after.pending];
    const position = started ? 1 : Math.max(2, sequence.length);
    return { track, position, started };
  }

  async getQueue(): Promise<MusicAssistantQueue> {
    const [queue, items, playback] = await Promise.all([
      this.rpc<PlayerQueue | null>("player_queues/get", { queue_id: this.playerId }),
      this.rpc<QueueItem[]>("player_queues/items", { queue_id: this.playerId }),
      this.getPlayback(),
    ]);
    if (!queue || queue.ended) {
      return {
        state: playback.state,
        ...(playback.current ? { current: playback.current } : {}),
        pending: [],
      };
    }
    if (queue.current_index === null || queue.current_index === undefined) {
      return {
        state: playback.state,
        ...(playback.current ? { current: playback.current } : {}),
        pending: items.map(mapQueueItem).filter(isQueueItem),
      };
    }
    const mapped = items.map(mapQueueItem);
    return {
      state: playback.state,
      ...(playback.current ? { current: playback.current } : {}),
      pending: mapped.slice(queue.current_index + 1).filter(isQueueItem),
    };
  }

  async getPlayback(): Promise<MusicAssistantPlayback> {
    const player = await this.rpc<Player | null>("players/get", { player_id: this.playerId });
    const media = player?.current_media;
    const title = media?.title;
    const artist = media?.artist;
    const current = media?.uri && title
      ? { uri: media.uri, title: artist ? `${artist} — ${title}` : title }
      : undefined;
    return {
      state: player?.state ?? "idle",
      ...(current ? { current } : {}),
    };
  }

  async clear(): Promise<void> {
    await this.rpc("player_queues/clear", { queue_id: this.playerId });
  }

  async next(): Promise<void> {
    await this.rpc("player_queues/next", { queue_id: this.playerId });
  }

  async play(): Promise<void> {
    await this.rpc("players/cmd/play", { player_id: this.playerId });
  }

  async playPreferred(searchQuery: string | undefined): Promise<void> {
    if (!searchQuery) return this.play();
    const [track, playback] = await Promise.all([this.searchTrack(searchQuery), this.getPlayback()]);
    if (playback.current?.uri === track.uri) return this.play();
    await this.rpc("player_queues/play_media", {
      queue_id: this.playerId,
      media: track.uri,
      option: "replace",
    });
  }

  async pause(): Promise<void> {
    await this.rpc("player_queues/pause", { queue_id: this.playerId });
  }

  private async searchTrack(searchQuery: string): Promise<MusicAssistantQueueItem> {
    const result = await this.rpc<{ tracks?: SearchTrack[] }>("music/search", {
      search_query: searchQuery,
      media_types: ["track"],
      limit: 5,
    });
    const track = result.tracks?.[0];
    if (!track?.uri) throw new Error(`Music Assistant не нашёл трек: ${searchQuery}`);
    const artists = track.artists?.map((artist) => artist.name).filter(Boolean).join(", ");
    return { uri: track.uri, title: artists ? `${artists} — ${track.name}` : track.name };
  }

  private async rpc<T = unknown>(command: string, args: Record<string, unknown>): Promise<T> {
    const response = await this.fetcher(`${this.baseUrl}/api`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ command, args }),
    });
    if (!response.ok) throw new Error(`Music Assistant не отвечает (${response.status})`);
    const payload = await response.json() as T | { error_code?: string; details?: string; message?: string };
    if (payload && typeof payload === "object" && "error_code" in payload && payload.error_code) {
      throw new Error(`Music Assistant: ${payload.details ?? payload.message ?? payload.error_code}`);
    }
    return payload as T;
  }
}

function mapQueueItem(item: QueueItem): MusicAssistantQueueItem | undefined {
  const uri = item.uri ?? item.media_item?.uri;
  const name = item.name ?? item.media_item?.name;
  if (!uri || !name) return undefined;
  const artists = item.media_item?.artists?.map((artist) => artist.name).filter(Boolean).join(", ");
  return { uri, title: artists ? `${artists} — ${name}` : name };
}

function isQueueItem(item: MusicAssistantQueueItem | undefined): item is MusicAssistantQueueItem {
  return item !== undefined;
}
