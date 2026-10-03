import { LocalTeamRpcGroup } from "@t3tools/contracts";
import {
  LOCAL_TEAM_FILES_METHOD,
  LOCAL_TEAM_FILES_STATE_METHOD,
} from "@t3tools/contracts/teamFiles";
import { LOCAL_PRESENCE_WS_METHODS } from "@t3tools/contracts/teamPresence";
import {
  LOCAL_TEAM_ACCEPT_METHOD,
  LOCAL_TEAM_DIRECTORY_METHOD,
  LOCAL_TEAM_MEMBERS_METHOD,
  LOCAL_TEAM_METHODS,
} from "@t3tools/contracts/teamProjects";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { LocalTeamProjects } from "./team/LocalTeamProjects.ts";

export const makeTeamWsRpcLayer = () =>
  LocalTeamRpcGroup.toLayer(
    Effect.gen(function* () {
      const teams = yield* LocalTeamProjects;
      const crypto = yield* Crypto.Crypto;
      const owner = yield* crypto.randomUUIDv4;
      return {
        [LOCAL_TEAM_FILES_METHOD]: (input) => teams.filesControl(input),
        [LOCAL_TEAM_FILES_STATE_METHOD]: (input) =>
          teams.filesControl({ action: "state", ...input }),
        [LOCAL_PRESENCE_WS_METHODS.heartbeat]: (input) =>
          teams.heartbeat(input.projectId, input.focus, owner),
        [LOCAL_PRESENCE_WS_METHODS.subscribe]: (input) =>
          teams.subscribePresence(input.projectId, owner),
        [LOCAL_TEAM_DIRECTORY_METHOD]: (input) => teams.directory(input.projectId),
        [LOCAL_TEAM_MEMBERS_METHOD]: (input) => teams.membership(input.projectId, input.command),
        [LOCAL_TEAM_ACCEPT_METHOD]: (input) =>
          teams.acceptInvitation(input.generation, input.token),
        [LOCAL_TEAM_METHODS.subscribeState]: () => teams.subscribeState,
        [LOCAL_TEAM_METHODS.state]: () => teams.state,
        [LOCAL_TEAM_METHODS.control]: (input) => teams.control(input),
        [LOCAL_TEAM_METHODS.subscribeProject]: (input) => teams.subscribeProject(input.projectId),
        [LOCAL_TEAM_METHODS.subscribeThread]: (input) =>
          teams.subscribeThread(input.projectId, input.threadId),
        [LOCAL_TEAM_METHODS.snapshot]: (input) =>
          teams.snapshot(input.projectId, input.threadId, input.window),
        [LOCAL_TEAM_METHODS.discuss]: (input) => teams.discuss(input.projectId, input.command),
      };
    }),
  );
