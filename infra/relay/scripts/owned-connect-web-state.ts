import * as Alchemy from "alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { localState } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { preparePrivateAlchemyRoot } from "./owned-connect-web-config.ts";

export function ownedPrivateAlchemyState(directory: string) {
  preparePrivateAlchemyRoot(directory);
  const context = {
    dotAlchemy: directory,
    dev: false,
    adopt: false,
    updateStateStore: false,
  } satisfies AlchemyContext["Service"];
  const state = localState().pipe(Layer.provide(Layer.succeed(AlchemyContext, context)));
  return { context, state };
}

/** Retain metadata inspected by the CLI while replacing its ambient execution context. */
export function withOwnedPrivateAlchemyContext<A, E, R, Req>(
  stack: Effect.Effect<A, E, R> & Alchemy.ConfiguredStackMeta<Req>,
  context: AlchemyContext["Service"],
) {
  return Object.assign(stack.pipe(Effect.provideService(AlchemyContext, context)), {
    stackName: stack.stackName,
    providers: stack.providers,
    state: stack.state,
    secrets: stack.secrets,
  });
}
