export function browserNetworkStatus(
  browserNavigator: Pick<Navigator, "onLine"> | undefined,
  androidApp: boolean,
): "unknown" | "offline" | "online" {
  if (browserNavigator === undefined) return "unknown";
  if (browserNavigator.onLine) return "online";
  // Android WebView can report offline while the VPN still reaches private
  // hosts. Unknown lets the supervisor use real connection results and its
  // bounded retry backoff instead of waiting forever for an online event.
  return androidApp ? "unknown" : "offline";
}
