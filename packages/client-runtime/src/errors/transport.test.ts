import { describe, expect, it } from "vite-plus/test";

import { NETWORK_BLOCKING_HINT } from "./network.ts";
import { isTransportConnectionErrorMessage, sanitizeThreadErrorMessage } from "./transport.ts";

describe("isTransportConnectionErrorMessage", () => {
  it("returns true for React Native disconnected socket errors", () => {
    expect(
      isTransportConnectionErrorMessage(
        "The operation couldn't be completed. Socket is not connected",
      ),
    ).toBe(true);
  });

  it("recognizes relay connection errors that carry the network hint", () => {
    for (const sentence of [
      "Relay environment disconnected.",
      "Relay environment stopped responding.",
      "Relay environment could not establish a WebSocket connection.",
    ]) {
      expect(isTransportConnectionErrorMessage(`${sentence} ${NETWORK_BLOCKING_HINT}`)).toBe(true);
    }
    expect(
      isTransportConnectionErrorMessage(
        "Your ChatGPT connection expired or was disconnected. Sign in again.",
      ),
    ).toBe(false);
  });

  it.each(["Arcwright Code", "T3"])("recognizes %s server WebSocket errors", (brand) => {
    expect(
      isTransportConnectionErrorMessage(`Unable to connect to the ${brand} server WebSocket.`),
    ).toBe(true);
  });
});

describe("sanitizeThreadErrorMessage", () => {
  it("strips transport errors", () => {
    expect(sanitizeThreadErrorMessage("SocketCloseError: oops")).toBeNull();
  });
});
