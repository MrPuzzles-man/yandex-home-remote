const OWNER_MAX_VOLUME = 10;
const USER_MAX_VOLUME = 6;

export function maxVolumeForRole(isOwner: boolean): number {
  return isOwner ? OWNER_MAX_VOLUME : USER_MAX_VOLUME;
}

export function validateVolumeForRole(level: number, isOwner: boolean): void {
  const minimum = isOwner ? 0 : 1;
  const maximum = maxVolumeForRole(isOwner);
  if (!Number.isInteger(level) || level < minimum || level > maximum) {
    throw new RangeError(
      isOwner
        ? "Громкость должна быть целым числом от 0 до 10"
        : "Для обычных пользователей доступна громкость от 1 до 6",
    );
  }
}
