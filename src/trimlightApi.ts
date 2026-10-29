import crypto from 'crypto';
import http from 'http';
import https from 'https';
import { URL } from 'url';

import type { CalendarSchedule, DailySchedule } from './schedule';

export const DEFAULT_BASE_URL = 'https://trimlight.ledhue.com/trimlight';

/** Device switch state as reported/accepted by the Trimlight API. */
export enum SwitchState {
  Off = 0,
  Manual = 1,
  Timer = 2,
}

/** API result code returned when the clientId/signature is rejected. */
export const AUTH_ERROR_CODE = 10001;

/**
 * API result code the cloud returns when it receives requests from the same
 * client too quickly / concurrently. Safe to retry after a short delay.
 */
export const RATE_LIMIT_ERROR_CODE = 20000;

/** A device as returned by the device list endpoint. */
export interface TrimlightDevice {
  deviceId: string;
  name: string;
  /** 0: offline, 1: online. */
  connectivity: number;
  /** 0: normal, 1: upgrading. */
  state: number;
  fwVersionName?: string;
  /**
   * Documented as part of the list response, but the real cloud omits it;
   * the authoritative value comes from the device detail.
   */
  switchState?: number;
}

/** The subset of the device detail response this plugin uses. */
export interface TrimlightDeviceDetail {
  switchState?: number;
  connectivity?: number;
  daily?: DailySchedule[];
  calendar?: CalendarSchedule[];
  [key: string]: unknown;
}

/** Date format the API expects for `currentDate` fields. */
export interface TrimlightDate {
  /** Years relative to 2000. */
  year: number;
  month: number;
  day: number;
  /** SUNDAY = 1 ... SATURDAY = 7. */
  weekday: number;
  hours: number;
  minutes: number;
  seconds: number;
}

interface ApiResponse<T> {
  code: number;
  desc?: string;
  payload?: T;
}

interface OAuthErrorBody {
  error?: unknown;
  error_description?: string;
}

/** OAuth error codes that mean the credentials/signature were not accepted. */
const OAUTH_AUTH_ERRORS = new Set(['invalid_token', 'invalid_client', 'unauthorized', 'unauthorized_client', 'access_denied']);

interface DeviceListPayload {
  total?: number;
  current?: number;
  data?: unknown[];
}

export interface TrimlightClientOptions {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Minimum spacing between consecutive requests; the cloud rejects bursts. */
  minRequestIntervalMs?: number;
  /** Total attempts for retryable failures (1 = no retries). */
  maxAttempts?: number;
  /** Base delay for exponential backoff between retries. */
  retryBaseDelayMs?: number;
  /** Clock used for signatures and `currentDate`; injectable for tests. */
  now?: () => Date;
  /** Optional debug logger. Never receives the client secret. */
  debug?: (message: string) => void;
}

export class TrimlightApiError extends Error {
  constructor(
    message: string,
    /** API result code, when the server answered with a parseable body. */
    public readonly code?: number,
    /** HTTP status, when the server answered at all. */
    public readonly status?: number,
    /** Whether a repeat of the same request could plausibly succeed. */
    public readonly retryable = false,
  ) {
    super(message);
    this.name = 'TrimlightApiError';
  }
}

export class TrimlightAuthError extends TrimlightApiError {
  constructor(message: string, code?: number, status?: number) {
    super(message, code, status, false);
    this.name = 'TrimlightAuthError';
  }
}

/**
 * Computes the access token per the Trimlight V2 OAuth API:
 * base64(HMAC-SHA256("Trimlight|<clientId>|<timestamp>", clientSecret)).
 */
export function generateAccessToken(clientId: string, clientSecret: string, timestamp: number): string {
  return crypto
    .createHmac('sha256', clientSecret)
    .update(`Trimlight|${clientId}|${timestamp}`)
    .digest('base64');
}

/** Converts a JS Date (local time) to the API's `currentDate` structure. */
export function toTrimlightDate(date: Date): TrimlightDate {
  return {
    year: date.getFullYear() - 2000,
    month: date.getMonth() + 1,
    day: date.getDate(),
    // JS getDay(): Sunday = 0 ... Saturday = 6; API: Sunday = 1 ... Saturday = 7.
    weekday: date.getDay() + 1,
    hours: date.getHours(),
    minutes: date.getMinutes(),
    seconds: date.getSeconds(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDevice(value: unknown): value is TrimlightDevice {
  return typeof value === 'object' && value !== null && typeof (value as TrimlightDevice).deviceId === 'string'
    && (value as TrimlightDevice).deviceId.length > 0;
}

/**
 * Minimal client for the Trimlight V2 cloud API.
 *
 * All requests are serialized and spaced out because the Trimlight cloud
 * rejects concurrent/rapid requests from the same client (error 20000).
 * Uses Node's built-in http(s) module rather than `fetch` so it runs on the
 * older Node versions HOOBS ships with, and because several endpoints are
 * GET requests that carry a JSON body (which `fetch` refuses to send).
 */
export class TrimlightClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly minRequestIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly now: () => Date;
  private readonly debug: (message: string) => void;

  private queueTail: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(options: TrimlightClientOptions) {
    if (!options.clientId || !options.clientSecret) {
      throw new Error('Trimlight clientId and clientSecret are required');
    }
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    // Ensure a trailing slash so relative resolution keeps the base path.
    const base = options.baseUrl ?? DEFAULT_BASE_URL;
    this.baseUrl = new URL(base.endsWith('/') ? base : `${base}/`);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.minRequestIntervalMs = options.minRequestIntervalMs ?? 300;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    this.now = options.now ?? (() => new Date());
    this.debug = options.debug ?? (() => undefined);
  }

  /** Returns all devices on the account. */
  async listDevices(): Promise<TrimlightDevice[]> {
    const payload = await this.request<DeviceListPayload>('GET', 'v1/oauth/resources/devices', { page: 0 });
    const data = payload?.data;
    if (!Array.isArray(data)) {
      throw new TrimlightApiError('Unexpected device list response: missing data array');
    }
    return data.filter(isDevice);
  }

  /** Returns the full device detail (switch state, effects, schedules, ...). */
  async getDeviceDetail(deviceId: string): Promise<TrimlightDeviceDetail> {
    const payload = await this.request<TrimlightDeviceDetail>('POST', 'v1/oauth/resources/device/get', {
      deviceId,
      currentDate: toTrimlightDate(this.now()),
    });
    if (typeof payload !== 'object' || payload === null) {
      throw new TrimlightApiError('Unexpected device detail response: missing payload');
    }
    return payload;
  }

  /** Sets the device switch state (0 off, 1 manual/on, 2 timer). */
  async setSwitchState(deviceId: string, switchState: SwitchState): Promise<void> {
    await this.request('POST', 'v1/oauth/resources/device/update', {
      deviceId,
      payload: { switchState },
    });
  }

  /**
   * Asks the controller to report its latest state to the cloud so the next
   * read is fresh. Best-effort: single attempt, errors are swallowed.
   */
  async notifyUpdateShadow(deviceId: string): Promise<void> {
    try {
      await this.request('GET', 'v1/oauth/resources/device/notify-update-shadow', {
        deviceId,
        currentDate: toTrimlightDate(this.now()),
      }, 1);
    } catch (error) {
      this.debug(`notify-update-shadow failed for ${deviceId}: ${(error as Error).message}`);
    }
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body: unknown, attempts = this.maxAttempts): Promise<T | undefined> {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await this.exclusive(() => this.send<T>(method, path, body));
        if (response.code === 0) {
          return response.payload;
        }
        const message = `Trimlight API error ${response.code}: ${response.desc ?? 'unknown error'}`;
        if (response.code === AUTH_ERROR_CODE) {
          throw new TrimlightAuthError(`${message} (check your clientId and clientSecret)`, response.code);
        }
        throw new TrimlightApiError(message, response.code, undefined, response.code === RATE_LIMIT_ERROR_CODE);
      } catch (error) {
        const retryable = error instanceof TrimlightApiError && error.retryable;
        if (!retryable || attempt >= attempts) {
          throw error;
        }
        const delay = this.retryBaseDelayMs * 2 ** (attempt - 1);
        this.debug(`${method} /${path} failed (attempt ${attempt}/${attempts}), retrying in ${delay}ms: ${(error as Error).message}`);
        // Back off outside the queue so other requests are not blocked.
        await sleep(delay);
      }
    }
  }

  /** Runs `fn` with exclusive access to the API, honoring the minimum spacing. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.queueTail;
    let release!: () => void;
    this.queueTail = new Promise<void>((resolve) => (release = resolve));

    return previous.then(async () => {
      try {
        const wait = this.lastRequestAt + this.minRequestIntervalMs - Date.now();
        if (wait > 0) {
          await sleep(wait);
        }
        return await fn();
      } finally {
        // Stamp even on failure: the server may still have processed it.
        this.lastRequestAt = Date.now();
        release();
      }
    });
  }

  private send<T>(method: string, path: string, body: unknown): Promise<ApiResponse<T>> {
    const url = new URL(path, this.baseUrl);
    const payload = Buffer.from(JSON.stringify(body ?? {}), 'utf8');
    const timestamp = this.now().getTime();
    const transport = url.protocol === 'http:' ? http : https;

    return new Promise<ApiResponse<T>>((resolve, reject) => {
      const req = transport.request(url, {
        method,
        headers: {
          'authorization': generateAccessToken(this.clientId, this.clientSecret, timestamp),
          'S-ClientId': this.clientId,
          'S-Timestamp': String(timestamp),
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          'Accept': 'application/json',
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', (error) => reject(new TrimlightApiError(`Response error: ${error.message}`, undefined, res.statusCode, true)));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString('utf8');
          if (status === 401 || status === 403) {
            reject(new TrimlightAuthError(`HTTP ${status} from Trimlight API (check your clientId and clientSecret)`, undefined, status));
            return;
          }
          if (status < 200 || status >= 300) {
            reject(new TrimlightApiError(`HTTP ${status} from Trimlight API`, undefined, status, status >= 500 || status === 429));
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(text);
          } catch {
            reject(new TrimlightApiError(`Invalid JSON from Trimlight API: ${text.slice(0, 200)}`, undefined, status));
            return;
          }
          // The gateway rejects bad signatures with an OAuth-style body (seen
          // with HTTP 207), e.g. {"error":"invalid_token","error_description":
          // "The access token expired"}, rather than the documented code 10001.
          const oauthError = typeof parsed === 'object' && parsed !== null ? (parsed as OAuthErrorBody) : undefined;
          if (oauthError && typeof oauthError.error === 'string') {
            const detail = oauthError.error_description ?? oauthError.error;
            if (OAUTH_AUTH_ERRORS.has(oauthError.error)) {
              reject(new TrimlightAuthError(
                `Trimlight rejected the request: ${detail} (check your clientId and clientSecret, and that this device's clock is correct)`,
                undefined, status));
            } else {
              reject(new TrimlightApiError(`Trimlight rejected the request: ${detail}`, undefined, status));
            }
            return;
          }
          if (typeof parsed !== 'object' || parsed === null || typeof (parsed as ApiResponse<T>).code !== 'number') {
            reject(new TrimlightApiError(`Unexpected response from Trimlight API: ${text.slice(0, 200)}`, undefined, status));
            return;
          }
          resolve(parsed as ApiResponse<T>);
        });
      });

      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new TrimlightApiError(`Request timed out after ${this.timeoutMs}ms`, undefined, undefined, true));
      });
      req.on('error', (error) => {
        reject(error instanceof TrimlightApiError
          ? error
          : new TrimlightApiError(`Network error: ${error.message}`, undefined, undefined, true));
      });
      req.end(payload);
    });
  }
}
