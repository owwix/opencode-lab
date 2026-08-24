export function decidePreviewLaunch({
  isOwnPreviewRunning,
  isHostPortListening
}) {
  if (isOwnPreviewRunning()) return "reuse";
  if (isHostPortListening(3100) || isHostPortListening(3101)) {
    return "skip-external";
  }
  return "start";
}
