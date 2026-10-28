import { isAndroidPwa, isElectron } from "./env";

export type PwaServiceWorkerState =
  | { readonly type: "unsupported" }
  | { readonly type: "ready"; readonly registration: ServiceWorkerRegistration }
  | { readonly type: "failed"; readonly error: Error };

let registrationPromise: Promise<PwaServiceWorkerState> | null = null;
let activeRegistration: ServiceWorkerRegistration | null = null;

/** Synchronous accessor for a registration preloaded during app boot. */
export function getActivePwaServiceWorkerRegistration(): ServiceWorkerRegistration | null {
  return activeRegistration;
}

function waitForActivation(
  registration: ServiceWorkerRegistration,
): Promise<ServiceWorkerRegistration> {
  if (registration.active !== null) return Promise.resolve(registration);
  const worker = registration.installing ?? registration.waiting;
  if (worker === null) {
    return Promise.reject(new Error("The service worker did not start installing."));
  }
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      worker.removeEventListener("statechange", onStateChange);
      reject(new Error("The service worker did not activate in time."));
    }, 5_000);
    const onStateChange = () => {
      if (worker.state === "activated") {
        window.clearTimeout(timeout);
        worker.removeEventListener("statechange", onStateChange);
        resolve(registration);
      } else if (worker.state === "redundant") {
        window.clearTimeout(timeout);
        worker.removeEventListener("statechange", onStateChange);
        reject(new Error("The service worker became redundant before activation."));
      }
    };
    worker.addEventListener("statechange", onStateChange);
  });
}

/** Registers the static worker only for the hosted HTTPS application. */
export function registerPwaServiceWorker(): Promise<PwaServiceWorkerState> {
  if (isElectron || isAndroidPwa || !window.isSecureContext || !("serviceWorker" in navigator)) {
    return Promise.resolve({ type: "unsupported" });
  }
  if (registrationPromise !== null) return registrationPromise;

  registrationPromise = navigator.serviceWorker
    .register("/service-worker.js", { scope: "/" })
    .then(waitForActivation)
    .then((registration) => {
      activeRegistration = registration;
      return { type: "ready", registration } as const;
    })
    .catch((cause: unknown) => {
      registrationPromise = null;
      return {
        type: "failed" as const,
        error:
          cause instanceof Error ? cause : new Error("Could not register the PWA service worker."),
      };
    });
  return registrationPromise;
}

/* Recover stale PWA shells by removing legacy workers and caches before reloading. Preserve the notification worker, which owns this installation’s push subscription. Pairings and settings in localStorage and IndexedDB stay intact. */
export async function clearPwaCachesAndReload(): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const registrations = (await navigator.serviceWorker?.getRegistrations()) ?? [];
    const notificationWorkerUrl = new URL("/service-worker.js", window.location.origin).href;
    await Promise.all(
      registrations
        .filter(
          (registration) =>
            ![registration.active, registration.waiting, registration.installing].some(
              (worker) => worker?.scriptURL === notificationWorkerUrl,
            ),
        )
        .map((registration) => registration.unregister()),
    );
  } catch {
    // A browser that refuses the registration list still benefits from the
    // cache drop and the reload below.
  }
  try {
    const keys = (await window.caches?.keys()) ?? [];
    await Promise.all(keys.map((key) => window.caches.delete(key)));
  } catch {
    // Same: a failure here must not stop the reload, which is what actually
    // re-fetches the shell.
  }
  // Reload the document, including when its URL has a fragment. Replacing an
  // identical fragment URL can remain a same-document navigation instead.
  window.location.reload();
}
