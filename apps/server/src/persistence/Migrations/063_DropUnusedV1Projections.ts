import * as Effect from "effect/Effect";

// Fork archival and recovery still read V1 history. Retain these tables until a
// separately verified archive migration can replace every reader without loss.
export default Effect.void;
