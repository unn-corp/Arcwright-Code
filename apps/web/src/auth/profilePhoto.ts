export function isProfileThumbnail(photo: unknown): photo is string {
  return (
    typeof photo === "string" &&
    photo.length <= 16_384 &&
    /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(photo)
  );
}

const operations = new Map<string, Promise<void>>();
/** A refresh that began before a local upload must finish before its replacement is published. */
export function serializeProfilePhoto<T>(principal: string, work: () => Promise<T>): Promise<T> {
  const pending = (operations.get(principal) ?? Promise.resolve()).then(work);
  const completed = pending.then(
    () => {},
    () => {},
  );
  operations.set(principal, completed);
  void completed.then(() => {
    if (operations.get(principal) === completed) operations.delete(principal);
  });
  return pending;
}
