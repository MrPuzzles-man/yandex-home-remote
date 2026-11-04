const REGULAR_USER_CALLBACKS = new Set([
  "home",
  "music",
  "music_prompt",
  "music_queue",
  "music_volume",
]);

export function canUseBotCallback(kind: string, isOwner: boolean): boolean {
  return isOwner || REGULAR_USER_CALLBACKS.has(kind);
}
