/**
 * Gateway composition root.
 *
 * The portable runtime deliberately has one browser session and one hub per attached page target.
 * Browser, agent, hub, and WebSocket behavior stay behind stable component boundaries; this file
 * owns lifecycle and wiring.
 */
import { encodeMsg, type Down, type Up } from "@mirror/protocol";
import Fastify from "fastify";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ACCESS_MAX_AGE_SECONDS, createAccessGate } from "./auth/access-gate";
import { createAssetCache } from "./assets/cache";
import { createAssetFetcher } from "./assets/fetch";
import { registerAssetRoutes } from "./assets/route";
import { mintInvite } from "./auth/invite";
import { SESSION_COOKIE, createSessionGuard } from "./auth/middleware";
import { createAgentLink } from "./browser/agentlink";
import { agentBridgeChannel, callAgentBridge } from "./browser/bridge";
import { launchBrowser, type BrowserHandle, type BrowserTargetInfo } from "./browser/launch";
import { createNavigationController } from "./browser/nav";
import { connectRemoteBrowser } from "./browser/remote";
import { createDownloadManager, registerDownloadRoutes } from "./downloads";
import { createUploadManager, registerUploadRoutes } from "./uploads";
import { createViewportAgreement } from "./hub/viewport";
import { createInputRelay, type InputMsg } from "./input/relay";
import { createScreencast, type ScreencastController } from "./px";
import { createRtcSignalRelay, type RtcSignalRelay } from "./rtcsig";
import { registerSecurityHeaders } from "./security-headers";
import { gatewayHost, registerViewerStatic } from "./serving";
import { createTabLifecycle, type TabLifecycle } from "./session/tabs";
import type { TargetRef } from "./types";
import { createRoleManager } from "./ws/roles";
import { createWsServer } from "./ws/server";
import type { ViewerConn } from "./ws/viewerconn";

const SESSION_ID = "dev";
const DEFAULT_PORT = 3000;

interface E2eBody {
  tab?: unknown;
  url?: unknown;
  expression?: unknown;
}

interface CdpEvaluateResult {
  result?: { value?: unknown; description?: string };
  exceptionDetails?: unknown;
}

function envPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return value;
}

function envNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function envProbability(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a number between 0 and 1`);
  }
  return value;
}

function seededRandom(seedText: string | undefined): (() => number) | undefined {
  if (seedText === undefined) return undefined;
  let state = 0x811c9dc5;
  for (const char of seedText) state = Math.imul(state ^ char.charCodeAt(0), 0x01000193);
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function bodyOf(value: unknown): E2eBody {
  return typeof value === "object" && value !== null ? (value as E2eBody) : {};
}

async function main(): Promise<void> {
  const configuredProfile = process.env.CHROME_USER_DATA_DIR;
  const managedProfile = configuredProfile === undefined;
  const userDataDir =
    configuredProfile ?? (await mkdtemp(join(tmpdir(), "mirror-gateway-chromium-")));
  const browser = await configuredBrowser(userDataDir);
  const healthTimer = setInterval(() => {
    if (browser.isAlive?.() === false) {
      console.error("Chrome process died; exiting for a clean supervisor restart");
      process.exit(1);
    }
  }, 2000);
  healthTimer.unref?.();
  // AgentLink is constructed before websocket fanout. Once publish exists below, clipboard
  // binding messages are relayed directly onto the frozen `clip` Down lane.
  let publishClipboard: ((message: Extract<Down, { t: "clip" }>) => void) | undefined;
  const agent = createAgentLink(browser, {
    publishClipboard: (message) => publishClipboard?.(message),
  });
  const app = Fastify({ logger: false });
  registerSecurityHeaders(app);
  const targets = new Map<string, TargetRef>();
  const targetInfo = new Map<string, BrowserTargetInfo>();
  const viewerIds = new WeakMap<ViewerConn, string>();
  const viewersById = new Map<string, ViewerConn>();
  const connectedViewerIds = new Set<string>();
  const e2eMode = process.env.MIRROR_E2E === "1";
  const authSecret = process.env.MIRROR_AUTH_SECRET;
  const sessionKey =
    authSecret === undefined || authSecret === "" ? randomBytes(32) : Buffer.from(authSecret);
  const driverSessionCookie = (): string => {
    const exp = Math.floor(Date.now() / 1_000) + ACCESS_MAX_AGE_SECONDS;
    const token = mintInvite({ sid: SESSION_ID, role: "driver", exp }, sessionKey);
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ACCESS_MAX_AGE_SECONDS}`;
  };
  const accessGate = createAccessGate({
    // The loopback-only E2E harness bypasses the gate below and exposes direct CDP-driving
    // endpoints. Give that explicitly unsafe test mode a non-secret placeholder so production
    // can continue to fail closed when MIRROR_ACCESS_PASSWORD is absent.
    ...(e2eMode ? { password: "e2e-test-only" } : {}),
    // Password-only device enrolment: the correct password also grants the driver session, so
    // there is no second link to open (and no fragment to lose behind the gate redirect).
    cookiesOnSuccess: () => [driverSessionCookie()],
  });
  const sessionGuard = createSessionGuard({ key: sessionKey });
  const assetTokenKey = randomBytes(32);
  app.addHook("preHandler", async (request, reply) => {
    // MIRROR_E2E already exposes direct CDP-driving endpoints and is never a production mode.
    // Its loopback-only harness cannot retain Secure cookies over HTTP, so the access gate is
    // bypassed entirely under e2e (not just /__e2e — the app root, download route, and static
    // assets the full-stack harness fetches must also be reachable). Production is unaffected.
    if (e2eMode) return;
    await accessGate.preHandler.call(app, request, reply);
    if (reply.sent) return;
    // Devices enrolled before password-only login (or whose invite simply expired) still hold a
    // valid access cookie, so they never revisit /gate and never receive a session cookie —
    // leaving the page loading forever as the WS upgrade is refused. Top it up in place.
    if (accessGate.hasValidDevice(request.raw) && sessionGuard.session(request.raw) === null) {
      reply.header("set-cookie", driverSessionCookie());
    }
  });
  accessGate.registerRoutes(app);
  await registerViewerStatic(app);
  sessionGuard.registerJoinRoutes(app);
  registerAssetRoutes(app, {
    serverKey: assetTokenKey,
    cache: createAssetCache(join(userDataDir, "asset-cache")),
    fetcher: createAssetFetcher({
      send: browser.send,
      sessionFor: (ref) =>
        ref.sessionId === SESSION_ID ? targets.get(ref.tabId)?.sessionId : undefined,
    }),
    preHandler: sessionGuard.preHandler,
  });
  let stopping = false;
  let nextViewerId = 1;
  let screencast: ScreencastController | undefined;
  let rtc: RtcSignalRelay | undefined;
  let tabs: TabLifecycle | undefined;
  const chaosRandom = seededRandom(process.env.P2_DIFF_CHAOS_SEED);

  let viewport: ReturnType<typeof createViewportAgreement>;
  const roles = createRoleManager({
    onDriverChange(change) {
      if (change.viewport !== undefined) viewport.handle(change.to, change.viewport);
    },
  });
  const isDriver = (viewerId: string): boolean => roles.isDriver(viewerId);
  viewport = createViewportAgreement({
    send: browser.send,
    sessionFor: (tabId) => targets.get(tabId)?.sessionId,
    hubFor: (tabId) => tabs?.hubFor(tabId),
    isDriver,
  });
  const inputRelay = createInputRelay({
    agentLink: agent,
    send: browser.send,
    callBridge: (sessionId, method, args) => callAgentBridge(browser, sessionId, method, args),
    sessionFor: (tabId) => targets.get(tabId)?.sessionId,
    isDriver,
    allowsInput: (viewerId, tabId) => viewport.gate.allowsInput(viewerId, tabId),
    noteInput: (tabId) => tabs?.hubFor(tabId)?.noteInput(),
    viewportFor: (tabId) => viewport.viewportFor(tabId),
  });

  const ws = createWsServer({
    server: app.server,
    hubs: () => tabs?.hubs() ?? [],
    authorizeUpgrade: (request) =>
      e2eMode || (accessGate.authorizeUpgrade(request) && sessionGuard.authorizeUpgrade(request)),
    simulatedRttMs: e2eMode ? envNonNegativeInt("MIRROR_E2E_WS_RTT_MS", 0) : 0,
    ...(e2eMode && process.env.P2_DIFF_CHAOS === "1"
      ? {
          deltaChaos: {
            dropRate: envProbability("P2_DIFF_CHAOS_RATE", 0.01),
            ...(chaosRandom === undefined ? {} : { random: chaosRandom }),
          },
        }
      : {}),
    onUp(viewer, msg) {
      return handleUp(viewer, msg);
    },
    onConnection(viewer, request) {
      const viewerId = `dev-${nextViewerId++}`;
      viewerIds.set(viewer, viewerId);
      const invite = sessionGuard.session(request);
      roles.connect({
        sessionId: SESSION_ID,
        inviteRole:
          invite?.sid === SESSION_ID
            ? invite.role
            : connectedViewerIds.size === 0
              ? "driver"
              : "viewer",
        viewerId,
        send: (message, serialized) => viewer.send(message, serialized),
      });
      viewersById.set(viewerId, viewer);
      connectedViewerIds.add(viewerId);
      void tabs
        ?.tabsMessage()
        .then((message) => viewer.send(message, encodeMsg(message)))
        .catch((error: unknown) => {
          if (!stopping) console.error("initial tabs message failed", error);
        });
    },
    onDisconnection(viewer) {
      const viewerId = viewerIds.get(viewer);
      if (viewerId === undefined) return;
      rtc?.removeViewer(viewerId);
      viewport.removeViewer(viewerId);
      roles.disconnect(viewerId);
      viewersById.delete(viewerId);
      connectedViewerIds.delete(viewerId);
    },
  });

  const publish = (down: Down): void => {
    if (down.t === "snapshot") viewport.noteSnapshot(down);
    ws.fanout.publish(down);
  };
  publishClipboard = publish;
  tabs = createTabLifecycle({
    browser,
    agentLink: agent,
    sessionId: SESSION_ID,
    assetTokenKey,
    publish,
    onError: (error) => {
      if (!stopping) console.error("tab lifecycle failed", error);
    },
  });
  rtc = createRtcSignalRelay({
    send: browser.send,
    callBridge: (sessionId, method, args) => callAgentBridge(browser, sessionId, method, args),
    bindingNameFor: (sessionId) => agentBridgeChannel(browser, sessionId)?.rtcBindingName,
    targets: browser,
    onBindingCalled: (callback) => browser.onSessionEvent("Runtime.bindingCalled", callback),
    sendViewer(viewerId, message) {
      const viewer = viewersById.get(viewerId);
      return viewer?.send(message, encodeMsg(message)) ?? false;
    },
    onError: (error) => {
      if (!stopping) console.error("RTC signaling failed", error);
    },
  });
  const navigation = createNavigationController(browser, publish);
  const downloadDir = join(userDataDir, "downloads");
  await mkdir(downloadDir, { recursive: true });
  const downloads = await createDownloadManager({
    sessionId: SESSION_ID,
    browser,
    downloadDir,
    publish,
    onError: (error) => {
      if (!stopping) console.error("download flow failed", error);
    },
  });
  registerDownloadRoutes(app, {
    preHandler: sessionGuard.preHandler,
    managerFor: (sessionId) => (sessionId === SESSION_ID ? downloads : undefined),
  });
  const uploadDir = join(userDataDir, "uploads", SESSION_ID);
  // A previous unclean exit can leave lazy Chromium file handles' backing files behind.
  await rm(uploadDir, { force: true, recursive: true });
  const uploads = await createUploadManager({
    sessionId: SESSION_ID,
    browser,
    uploadDir,
    publish,
    onError: (error) => {
      if (!stopping) console.error("upload flow failed", error);
    },
  });
  registerUploadRoutes(app, {
    preHandler: sessionGuard.preHandler,
    managerFor: (sessionId) => (sessionId === SESSION_ID ? uploads : undefined),
  });

  async function handleUp(viewer: ViewerConn, msg: Up): Promise<void> {
    const viewerId = viewerIds.get(viewer);
    if (viewerId === undefined) return;
    await roles.routeUp(viewerId, msg, (forwarded) => handleAuthorizedUp(viewerId, forwarded));
  }

  async function handleAuthorizedUp(viewerId: string, msg: Up): Promise<void> {
    if (msg.t === "rtc-sig") {
      await rtc?.handleViewer(viewerId, msg);
      return;
    }
    if (msg.t === "resync-req") {
      const hub = tabs?.hubFor(msg.tab);
      if (hub === undefined) return;
      ws.fanout.flushAll();
      // Replayer exceptions can be caused by a toxic buffered delta. A real fresh snapshot drops
      // that tail and bumps the epoch; TabHub's existing F3 retry chain keeps trying invisibly.
      hub.requestSnapshot("resync");
      return;
    }
    if (msg.t === "view" || msg.t === "view-ack") {
      viewport.handle(viewerId, msg);
      return;
    }
    if (msg.t === "nav") {
      if (msg.action === "newtab" || msg.action === "close" || msg.action === "activate") {
        await tabs?.handle(msg);
      } else {
        await navigation.handle(msg);
      }
      return;
    }
    if (msg.t === "mode") {
      await screencast?.handle(msg);
      return;
    }
    if (isInputMsg(msg)) await inputRelay(viewerId, msg);
  }

  function pageTarget(tab?: unknown): TargetRef | undefined {
    if (typeof tab === "string") {
      const requested = targets.get(tab);
      if (requested?.type === "page") return requested;
    }
    return [...targets.values()].find((target) => target.type === "page");
  }

  browser.onTargetInfoChanged((info) => targetInfo.set(info.targetId, info));
  browser.onDetached((target) => {
    if (targets.get(target.targetId)?.sessionId !== target.sessionId) return;
    targets.delete(target.targetId);
    targetInfo.delete(target.targetId);
  });
  browser.onAttached((target) => {
    targets.set(target.targetId, target);
  });

  screencast = createScreencast({
    browser,
    hubFor: (tabId) => tabs?.hubFor(tabId),
    publish,
    onError: (error) => {
      if (!stopping) console.error("screencast failed", error);
    },
  });

  app.get("/healthz", async () => ({
    ok: browser.isAlive?.() !== false,
    browser: browser.isAlive?.() !== false,
  }));

  // The live smoke harness needs a pipe-safe way to drive the authoritative Chromium. These
  // routes do not exist in normal development or production and add no page-content policy.
  if (e2eMode) {
    app.get("/__e2e/probe", async () => ({ serverTs: Date.now() }));

    app.get("/__e2e/input-stats", async (request) => {
      const query =
        typeof request.query === "object" && request.query !== null
          ? (request.query as { tab?: unknown })
          : {};
      const tab = typeof query.tab === "string" ? query.tab : undefined;
      return {
        rectFallbacks: tab === undefined ? 0 : inputRelay.rectFallbacksFor(tab),
        inputReady:
          tab !== undefined &&
          [...connectedViewerIds].some(
            (viewerId) => roles.isDriver(viewerId) && viewport.gate.allowsInput(viewerId, tab),
          ),
      };
    });

    app.get("/__e2e/state", async () => ({
      tabs: [...(tabs?.hubs() ?? [])].map((hub) => ({
        tab: hub.tabId,
        epoch: hub.epoch,
        docId: hub.docId,
        seq: hub.seq,
        url: targetInfo.get(hub.tabId)?.url ?? "",
      })),
    }));

    app.get("/__e2e/chaos", async () => ws.fanout.chaosStats);

    app.post("/__e2e/navigate", async (request, reply) => {
      const body = bodyOf(request.body);
      const target = pageTarget(body.tab);
      if (target === undefined) return reply.code(409).send({ error: "no page target" });
      if (typeof body.url !== "string" || body.url.trim() === "") {
        return reply.code(400).send({ error: "url is required" });
      }
      const result = await browser.send(target.sessionId, "Page.navigate", { url: body.url });
      return { tab: target.targetId, result };
    });

    app.post("/__e2e/evaluate", async (request, reply) => {
      const body = bodyOf(request.body);
      const target = pageTarget(body.tab);
      if (target === undefined) return reply.code(409).send({ error: "no page target" });
      if (typeof body.expression !== "string" || body.expression.trim() === "") {
        return reply.code(400).send({ error: "expression is required" });
      }
      const result = (await browser.send(target.sessionId, "Runtime.evaluate", {
        expression: body.expression,
        awaitPromise: true,
        returnByValue: true,
      })) as CdpEvaluateResult;
      if (result.exceptionDetails !== undefined) {
        return reply.code(422).send({ error: result.result?.description ?? "evaluation failed" });
      }
      return { value: result.result?.value };
    });

    app.post("/__e2e/snapshot", async (request, reply) => {
      const target = pageTarget(bodyOf(request.body).tab);
      if (target === undefined) return reply.code(409).send({ error: "no page target" });
      const result = await agent.sendCmd(target.targetId, { cmd: "snapshot" });
      return { tab: target.targetId, result };
    });
  }

  const stop = async (signal?: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(healthTimer);
    if (signal !== undefined) console.log(`gateway stopping on ${signal}`);
    uploads.close();
    downloads.close();
    rtc?.dispose();
    rtc = undefined;
    tabs?.dispose();
    tabs = undefined;
    navigation.dispose();
    viewport.dispose();
    screencast?.dispose();
    screencast = undefined;
    await ws.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    await rm(uploadDir, { force: true, recursive: true });
    if (managedProfile) await rm(userDataDir, { force: true, recursive: true });
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void stop(signal).finally(() => process.exit(0));
    });
  }

  try {
    const port = envPort("GATEWAY_PORT", DEFAULT_PORT);
    const host = gatewayHost();
    await app.listen({ host, port });
    console.log(`mirror gateway listening at http://${host}:${port}`);
  } catch (error) {
    await stop();
    throw error;
  }
}

async function configuredBrowser(userDataDir: string): Promise<BrowserHandle> {
  const cdpUrl = process.env.BROWSER_CDP_URL;
  if (cdpUrl !== undefined && cdpUrl.trim() !== "") {
    return connectRemoteBrowser(cdpUrl, {
      timeoutMs: envNonNegativeInt("BROWSER_CDP_TIMEOUT_MS", 30_000) || 30_000,
    });
  }

  const executablePath = process.env.CHROME_PATH;
  if (executablePath === undefined || executablePath.trim() === "") {
    throw new Error("set BROWSER_CDP_URL or point CHROME_PATH to a Chromium executable");
  }
  return launchBrowser({
    executablePath,
    headful: process.env.CHROME_HEADFUL === "1",
    userDataDir,
    args: ["--disable-dev-shm-usage"],
  });
}

function isInputMsg(msg: Up): msg is InputMsg {
  return (
    msg.t === "ptr" ||
    msg.t === "key" ||
    msg.t === "text" ||
    msg.t === "value" ||
    msg.t === "ime" ||
    msg.t === "scroll"
  );
}

await main();
