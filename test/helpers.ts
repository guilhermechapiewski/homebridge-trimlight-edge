import http from 'http';
import { AddressInfo } from 'net';
import type { Logger } from 'homebridge';

import { TrimlightDevice } from '../src/trimlightApi';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
  receivedAt: number;
}

export type Handler = (req: RecordedRequest) =>
  | { status?: number; body?: unknown; raw?: string; delayMs?: number; hang?: boolean }
  | Promise<{ status?: number; body?: unknown; raw?: string; delayMs?: number; hang?: boolean }>;

/** A real HTTP server on localhost that records requests and replies via `handler`. */
export class MockServer {
  readonly requests: RecordedRequest[] = [];
  handler: Handler = () => ({ body: { code: 0, desc: 'success' } });
  inFlight = 0;
  maxInFlight = 0;
  private server = http.createServer((req, res) => this.handle(req, res));
  private sockets = new Set<import('net').Socket>();

  async start(): Promise<string> {
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/trimlight`;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', async () => {
      this.inFlight++;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      const text = Buffer.concat(chunks).toString('utf8');
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: text ? JSON.parse(text) : undefined,
        receivedAt: Date.now(),
      };
      this.requests.push(recorded);
      const reply = await this.handler(recorded);
      if (reply.hang) {
        this.inFlight--;
        return;
      }
      if (reply.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
      }
      this.inFlight--;
      res.statusCode = reply.status ?? 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(reply.raw ?? JSON.stringify(reply.body ?? { code: 0, desc: 'success' }));
    });
  }
}

export function makeLogger(): jest.Mocked<Logger> {
  const log = jest.fn() as unknown as jest.Mocked<Logger>;
  Object.assign(log, {
    prefix: 'test',
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    success: jest.fn(),
    log: jest.fn(),
  });
  return log;
}

export function makeDevice(overrides: Partial<TrimlightDevice> = {}): TrimlightDevice {
  return {
    deviceId: 'device-1',
    name: 'Front House',
    switchState: 0,
    connectivity: 1,
    state: 0,
    fwVersionName: '1.2.3',
    ...overrides,
  };
}
