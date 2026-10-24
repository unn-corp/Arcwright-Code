// Arcwright intentionally has no generated-code preview runner.
// Importing this module has no side effects; the CLI always fails closed.
import { main } from "./paths.mjs";
export const unavailable = "Preview unavailable: no supported isolated, credential-free, network-denied runner. No browser launched and no dependencies installed.";
if (main(import.meta.url)) { console.error(unavailable); process.exitCode = 3; }
