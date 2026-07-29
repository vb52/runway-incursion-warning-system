// Lets VideoFeed (LiveMonitor's camera preview) mirror DetectorConfig.tsx's
// <video> element via canvas instead of owning a second independent decode
// of the same ~330MB source. Before this, both pages ran their own <video>
// at once whenever the operator was actually on 主戰情表 (the page this
// complaint is about) — DetectorConfig's copy can never pause (detection
// depends on it decoding continuously in the background), so the earlier
// "pause VideoFeed when its page isn't visible" fix only helped while
// looking at OTHER pages, not the main one. A canvas drawImage() copy each
// frame is essentially free next to a full second decode pipeline.
let element: HTMLVideoElement | null = null;
type Listener = (el: HTMLVideoElement | null) => void;
const listeners = new Set<Listener>();

export function setDetectorVideoElement(el: HTMLVideoElement | null): void {
  element = el;
  listeners.forEach((fn) => fn(element));
}

export function getDetectorVideoElement(): HTMLVideoElement | null {
  return element;
}

// Re-attach when the registered element changes (defensive — DetectorConfig
// is always-mounted per Layout.tsx so this fires once in practice, but a
// consumer that mounts before DetectorConfig's effect runs needs to know
// when it becomes available rather than staying stuck on a null snapshot).
export function onDetectorVideoElementChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
