import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const BACKGROUND_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const BACKGROUND_IMAGE_MAX_BYTES = 64 * 1024 * 1024;

const listBackgroundImageNames = Effect.fn("desktop.ipc.backgroundImages.listNames")(function* (
  directory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fileSystem.readDirectory(directory);
  return entries
    .filter((entry) => BACKGROUND_IMAGE_EXTENSIONS.has(path.extname(entry).toLowerCase()))
    .toSorted((left, right) => left.localeCompare(right));
});

export const listBackgroundImages = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.LIST_BACKGROUND_IMAGES_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(Schema.String),
  handler: Effect.fn("desktop.ipc.backgroundImages.list")(function* () {
    const config = yield* DesktopConfig.DesktopConfig;
    if (Option.isNone(config.backgroundImagesDirectory)) return [];
    return yield* listBackgroundImageNames(config.backgroundImagesDirectory.value).pipe(
      Effect.orElseSucceed(() => []),
    );
  }),
});

export const readBackgroundImage = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.READ_BACKGROUND_IMAGE_CHANNEL,
  payload: Schema.String,
  result: Schema.NullOr(Schema.Uint8Array),
  handler: Effect.fn("desktop.ipc.backgroundImages.read")(function* (name) {
    const config = yield* DesktopConfig.DesktopConfig;
    if (Option.isNone(config.backgroundImagesDirectory)) return null;
    const directory = config.backgroundImagesDirectory.value;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* Effect.gen(function* () {
      const names = yield* listBackgroundImageNames(directory);
      if (!names.includes(name)) return null;
      const filePath = path.join(directory, name);
      const stat = yield* fileSystem.stat(filePath);
      if (stat.type !== "File" || Number(stat.size) > BACKGROUND_IMAGE_MAX_BYTES) return null;
      return yield* fileSystem.readFile(filePath);
    }).pipe(Effect.orElseSucceed(() => null));
  }),
});
