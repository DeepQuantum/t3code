import type { DesktopBridge } from "@t3tools/contracts";

const BACKGROUND_LAYER_ID = "app-background";
const SLIDE_INTERVAL_MS = 60_000;
const IMAGE_WIDTH_PX = 1920;
const BLUR_PX = 0;
const BRIGHTNESS = 0.6;
const IMAGE_JPEG_QUALITY = 0.8;

function shuffled<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}

async function renderBlurredImage(bytes: Uint8Array): Promise<string> {
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]), {
    resizeWidth: IMAGE_WIDTH_PX,
    resizeQuality: "medium",
  });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("2d canvas context unavailable");
    const margin = BLUR_PX * 2;
    context.filter = `blur(${BLUR_PX}px) brightness(${BRIGHTNESS})`;
    context.drawImage(
      bitmap,
      -margin,
      -margin,
      bitmap.width + margin * 2,
      bitmap.height + margin * 2,
    );
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: IMAGE_JPEG_QUALITY });
    return URL.createObjectURL(blob);
  } finally {
    bitmap.close();
  }
}

async function run(bridge: Pick<DesktopBridge, "listBackgroundImages" | "readBackgroundImage">) {
  const names = shuffled(await bridge.listBackgroundImages());
  if (names.length === 0) return;

  const layer = document.createElement("div");
  layer.id = BACKGROUND_LAYER_ID;
  const slides: readonly [HTMLDivElement, HTMLDivElement] = [
    document.createElement("div"),
    document.createElement("div"),
  ];
  layer.append(...slides);
  const slideUrls: [string | null, string | null] = [null, null];
  let visibleSlide: 0 | 1 = 1;
  let nextName = 0;

  const showNext = async (): Promise<boolean> => {
    const name = names[nextName % names.length]!;
    nextName += 1;
    try {
      const bytes = await bridge.readBackgroundImage(name);
      if (bytes === null) return false;
      const url = await renderBlurredImage(bytes);
      const incoming = visibleSlide === 0 ? 1 : 0;
      const staleUrl = slideUrls[incoming];
      if (staleUrl !== null) URL.revokeObjectURL(staleUrl);
      slideUrls[incoming] = url;
      slides[incoming].style.backgroundImage = `url("${url}")`;
      slides[incoming].dataset.active = "true";
      delete slides[visibleSlide].dataset.active;
      visibleSlide = incoming;
      return true;
    } catch {
      return false;
    }
  };

  for (let attempt = 0; attempt < names.length; attempt += 1) {
    if (await showNext()) break;
  }
  if (slideUrls[0] === null && slideUrls[1] === null) return;

  document.body.append(layer);
  document.documentElement.dataset.appBackground = "true";

  const scheduleNext = () => {
    window.setTimeout(async () => {
      if (document.visibilityState === "visible") await showNext();
      scheduleNext();
    }, SLIDE_INTERVAL_MS);
  };
  scheduleNext();
}

export function startAppBackground(bridge: DesktopBridge | undefined): void {
  if (bridge === undefined || typeof bridge.listBackgroundImages !== "function") return;
  void run(bridge);
}
