import crypto from "node:crypto";
import { buildDesktopDevicePayload, desktopDevicePublicKeySha256, desktopDeviceRequestTarget, readDesktopDevicePlatform, DESKTOP_DEVICE_AUTH_HEADERS } from "@codeflowai/shared/desktop-device-auth";
import { signDevicePayload, type DeviceIdentity } from "./deviceIdentity.js";
import { preserveUpdateNetworkCancellation, type UpdateNetworkRetry } from "./updateNetworkRetry.js";

type UpdateRequest = { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD"; path: string; body?: unknown;
  range?: string | null; ifMatch?: string | null; requestId?: string; signal?: AbortSignal;
  /** 仅文件下载显式启用正文空闲预算；默认含 raw JSON 均保留总超时。 */
  streamResponse?: true };
const REMOTE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

/** 固定 origin 与唯一 signer 供更新下载、阶段回执和错误补报复用，不自动联网。 */
export function createDesktopUpdateTransport(input: { dataDir: string; identity: DeviceIdentity; configuredServerOrigin: string; timeoutMs?: number;
  /** 账号 Server 可显式使用 HTTP；例外仅用于签名登记，不能下载更新或发送回执。 */
  allowHttpRegistration?: boolean;
  /** 设备登记与心跳需要的版本事实；旧构造点缺省为 unknown。 */
  getVersions?: () => { shellVersion: string; webVersion: string; clientVersion: string; releaseId: string };
  getNetworkContext?: () => { signal: AbortSignal; retry: UpdateNetworkRetry } | undefined }) {
  const identity = { deviceId: input.identity.deviceId, publicKeyBase64: input.identity.publicKeyBase64 };
  const publicKeySha256 = desktopDevicePublicKeySha256(identity.publicKeyBase64);
  const origin = new URL(input.configuredServerOrigin);
  const localHttp = origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  const registrationHttp = origin.protocol === "http:" && !localHttp && input.allowHttpRegistration === true;
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash
    || origin.origin !== input.configuredServerOrigin || (origin.protocol !== "https:" && !localHttp && !registrationHttp)) throw new Error("DESKTOP_UPDATE_ORIGIN_INVALID");
  const timeoutMs = input.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error("DESKTOP_UPDATE_TIMEOUT_INVALID");

  /** 对确切正文签名；文件单独约束响应头等待，JSON 保持整次响应总超时。 */
  const send = async (request: UpdateRequest, body: Uint8Array, raw = false, streaming = false): Promise<Response> => {
    request.signal?.throwIfAborted();
    if (registrationHttp && (request.method !== "POST" || request.path !== "/api/software/desktop/devices/register")) throw new Error("DESKTOP_UPDATE_ORIGIN_INVALID");
    desktopDeviceRequestTarget(request.path);
    const url = new URL(request.path, origin);
    if (url.origin !== origin.origin) throw new Error("DESKTOP_UPDATE_ORIGIN_INVALID");
    const metadata = { requestId: request.requestId ?? crypto.randomUUID(), timestamp: Date.now() };
    const signature = await signDevicePayload(input.dataDir, buildDesktopDevicePayload({ ...metadata, deviceId: identity.deviceId,
      method: request.method, url: request.path, body, range: request.range, ifMatch: request.ifMatch }));
    if (signature.deviceId !== identity.deviceId || signature.publicKeyBase64 !== identity.publicKeyBase64) throw new Error("DESKTOP_DEVICE_IDENTITY_CHANGED");
    const headers: Record<string, string> = { [DESKTOP_DEVICE_AUTH_HEADERS.version]: "v1", [DESKTOP_DEVICE_AUTH_HEADERS.deviceId]: identity.deviceId,
      [DESKTOP_DEVICE_AUTH_HEADERS.requestId]: metadata.requestId, [DESKTOP_DEVICE_AUTH_HEADERS.timestamp]: String(metadata.timestamp),
      [DESKTOP_DEVICE_AUTH_HEADERS.signature]: signature.signature };
    if (body.byteLength) headers["content-type"] = "application/json";
    if (request.range != null) headers.range = request.range;
    if (request.ifMatch != null) headers["if-match"] = request.ifMatch;
    const timeout = streaming ? new AbortController() : undefined;
    const timer = timeout ? setTimeout(() => timeout.abort(new DOMException("Update response headers timed out", "TimeoutError")), timeoutMs) : undefined;
    timer?.unref();
    const signal = AbortSignal.any([timeout?.signal ?? AbortSignal.timeout(timeoutMs), ...(request.signal ? [request.signal] : [])]);
    let response: Response;
    try {
      response = await fetch(url, { method: request.method, headers, body: body.byteLength ? Buffer.from(body) : undefined,
        redirect: "error", credentials: "omit", signal });
    } catch (cause) {
      clearTimeout(timer);
      throw Object.assign(new Error("DESKTOP_UPDATE_TRANSPORT_FAILED", { cause: preserveUpdateNetworkCancellation(cause, request.signal) }),
        { code: "DESKTOP_UPDATE_TRANSPORT_FAILED", requestId: metadata.requestId });
    }
    if (streaming && response.ok) {
      clearTimeout(timer);
      return withBodyTimeout(response, timeout!, signal, metadata.requestId);
    }
    if (!raw && !response.ok) {
      const retryAfter = response.headers.get("retry-after");
      let failure: unknown;
      try { failure = await response.json(); }
      catch (cause) {
        throw Object.assign(new Error("DESKTOP_UPDATE_HTTP_FAILED", { cause: cause instanceof SyntaxError ? new Error("DESKTOP_UPDATE_RESPONSE_INVALID")
          : preserveUpdateNetworkCancellation(cause, request.signal) }),
          { code: "DESKTOP_UPDATE_HTTP_FAILED", requestId: metadata.requestId, status: response.status, retryAfter });
      }
      finally { clearTimeout(timer); }
      const value = failure && typeof failure === "object" ? failure as Record<string, unknown> : {};
      throw Object.assign(new Error("DESKTOP_UPDATE_HTTP_FAILED"),
        { code: safeRemoteErrorCode(value.code, "DESKTOP_UPDATE_HTTP_FAILED"), transportCode: "DESKTOP_UPDATE_HTTP_FAILED",
          requestId: metadata.requestId, status: response.status, retryAfter });
    }
    return response;
  };

  /** 只为等待下一段正文计空闲时间；消费方处理数据不占网络预算，取消与根因原样保留。 */
  const withBodyTimeout = (response: Response, timeout: AbortController, signal: AbortSignal, requestId: string): Response => {
    if (!response.body) return response;
    const reader = response.body.getReader();
    let finished = false;
    /** 读流主因保留；取消和释放的独立失败聚合，清理错误不能被当作可重试网络故障。 */
    const closeReader = async (cancel: boolean, reason?: unknown, failure?: { cause: unknown }): Promise<void> => {
      try { if (cancel) await reader.cancel(reason); }
      catch (cause) {
        if (!failure || !Object.is(cause, failure.cause)) failure = { cause: new AggregateError(failure ? [failure.cause, cause] : [cause], "DESKTOP_UPDATE_BODY_CANCEL_FAILED") };
      }
      try { reader.releaseLock(); }
      catch (cause) { failure = { cause: new AggregateError(failure ? [failure.cause, cause] : [cause], "DESKTOP_UPDATE_BODY_RELEASE_FAILED") }; }
      if (failure) throw preserveUpdateNetworkCancellation(failure.cause, signal);
    };
    const body = new ReadableStream<Uint8Array>({
      /** 按需读取防止提前缓存；每次收到字节后结束本次等待预算。 */
      async pull(controller) {
        const timer = setTimeout(() => timeout.abort(Object.assign(new DOMException("Update response body stalled", "TimeoutError"), { requestId })), timeoutMs);
        timer.unref();
        let next!: ReadableStreamReadResult<Uint8Array>, failure: { cause: unknown } | undefined;
        try {
          next = await reader.read();
        } catch (cause) { failure = { cause }; }
        finally { clearTimeout(timer); }
        if (failure) {
          if (finished) throw preserveUpdateNetworkCancellation(failure.cause, signal);
          finished = true;
          await closeReader(true, undefined, failure);
          return;
        }
        if (finished) return;
        if (next.done) { finished = true; await closeReader(false); controller.close(); }
        else controller.enqueue(next.value);
      },
      /** 消费方放弃时同步取消上游，清理失败交回 owner。 */
      async cancel(reason) {
        finished = true;
        await closeReader(true, reason);
      },
    }, { highWaterMark: 0 });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };

  /** 固定本次 ID 与确切正文，普通/raw/JSON 入口共同使用同一序列化。 */
  const prepare = (request: UpdateRequest) => ({ requestId: request.requestId ?? crypto.randomUUID(),
    body: request.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(request.body), "utf8") });

  /** 一次公共动作只获取一份上下文；JSON 读取与登记确认属于同一次重试。 */
  const runNetwork = async <T>(signal: AbortSignal | undefined, operation: (signal: AbortSignal | undefined) => Promise<T>): Promise<T> => {
    const context = input.getNetworkContext?.();
    const combined = context ? signal ? AbortSignal.any([context.signal, signal]) : context.signal : signal;
    return context ? await context.retry.run(() => operation(combined)) : await operation(combined);
  };

  /** 非 JSON 响应不能把远端正文片段带入异常链，读流失败仍保留原始原因。 */
  const readJson = async (response: Response, requestId: string, signal?: AbortSignal): Promise<unknown> => {
    try { return await response.json(); }
    catch (cause) {
      throw Object.assign(new Error("DESKTOP_UPDATE_RESPONSE_INVALID", { cause: cause instanceof SyntaxError ? new Error("INVALID_JSON")
        : preserveUpdateNetworkCancellation(cause, signal) }),
        { code: "DESKTOP_UPDATE_RESPONSE_INVALID", requestId });
    }
  };

  return {
    /** 单次物理发送，非 2xx 也只交响应；完整正文、HTTP 失败和清理由外层 owner 负责。 */
    async requestRaw(request: UpdateRequest): Promise<Response> {
      const { requestId, body } = prepare(request);
      return await send({ ...request, requestId }, body, true, request.streamResponse === true);
    },
    /** 正文与 requestId 固定一次；只重试取得响应，归档读流由下载器负责。 */
    async request(request: UpdateRequest): Promise<Response> {
      const { requestId, body } = prepare(request);
      return await runNetwork(request.signal, async signal => await send({ ...request, requestId, signal }, body, false, request.streamResponse === true));
    },
    /** JSON 结构及业务失败保留请求标识，回执和错误补报不能把 HTTP 200 当成业务成功。 */
    async requestJson<T extends object>(input: UpdateRequest): Promise<T & { ok: true }> {
      const { requestId, body: bytes } = prepare(input);
      return await runNetwork(input.signal, async signal => {
        const response = await send({ ...input, requestId, signal }, bytes);
        const value = await readJson(response, requestId, signal);
        if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as Record<string, unknown>).ok !== "boolean") {
          throw Object.assign(new Error("DESKTOP_UPDATE_RESPONSE_INVALID"), { code: "DESKTOP_UPDATE_RESPONSE_INVALID", requestId });
        }
        const body = value as Record<string, unknown>;
        if (body.ok !== true) throw Object.assign(new Error("DESKTOP_UPDATE_REQUEST_FAILED"),
          { code: safeRemoteErrorCode(body.code, "DESKTOP_UPDATE_REQUEST_FAILED"), requestId });
        return value as T & { ok: true };
      });
    },
    /** 平台来自当前壳二进制；登记前校验，确认仍只核对设备和公钥摘要。 */
    async register(options: { signal?: AbortSignal; requestId?: string } = {}): Promise<{ deviceId: string; publicKeySha256: string }> {
      options.signal?.throwIfAborted();
      const platform = readDesktopDevicePlatform(process.platform, process.arch);
      const versions = input.getVersions?.() ?? { shellVersion: "unknown", webVersion: "unknown", clientVersion: "unknown", releaseId: "unknown" };
      const body = Buffer.from(JSON.stringify({ deviceId: identity.deviceId, publicKeyBase64: identity.publicKeyBase64, ...platform,
        shellVersion: versions.shellVersion, webVersion: versions.webVersion,
        clientVersion: versions.clientVersion, releaseId: versions.releaseId }), "utf8");
      const requestId = options.requestId ?? crypto.randomUUID();
      return await runNetwork(options.signal, async signal => {
        const response = await send({ method: "POST", path: "/api/software/desktop/devices/register", signal, requestId }, body);
        const ack = await readJson(response, requestId, signal);
        if (!ack || typeof ack !== "object" || Array.isArray(ack) || Object.keys(ack).length !== 3
          || (ack as Record<string, unknown>).ok !== true || (ack as Record<string, unknown>).deviceId !== identity.deviceId
          || (ack as Record<string, unknown>).publicKeySha256 !== publicKeySha256) {
          throw Object.assign(new Error("DESKTOP_DEVICE_REGISTRATION_ACK_INVALID"), { code: "DESKTOP_DEVICE_REGISTRATION_ACK_INVALID", requestId });
        }
        return { deviceId: identity.deviceId, publicKeySha256 };
      });
    },
  };
}

/** 仅接受短 ASCII 错误码，避免远端正文伪装为本地诊断字段。 */
function safeRemoteErrorCode(value: unknown, fallback: string): string {
  return typeof value === "string" && REMOTE_ERROR_CODE.test(value) ? value : fallback;
}
