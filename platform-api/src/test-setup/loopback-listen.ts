import net from "node:net";
import { createRequire } from "node:module";
import { Server as TlsServer } from "node:tls";

// macOS lets an explicit host:port bind coexist with — and capture the
// loopback traffic of — another socket's wildcard bind on the same port
// (libuv sets SO_REUSEADDR on every TCP listener). Test servers bind
// ephemeral wildcard ports while their clients dial 127.0.0.1, so any
// process that re-binds a probed port explicitly can answer a test's
// requests with foreign 401s/404s. Rebinding every test listener to
// 127.0.0.1 makes it the most-specific match for the address its clients
// dial.
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", ""]);
const originalListen = net.Server.prototype.listen;

net.Server.prototype.listen = function listen(this: net.Server, ...args: unknown[]): net.Server {
  if (typeof args[0] === "number" && typeof args[1] === "string") {
    if (WILDCARD_HOSTS.has(args[1])) args[1] = "127.0.0.1";
  } else if (typeof args[0] === "number") {
    args.splice(1, 0, "127.0.0.1");
  } else if (typeof args[0] === "object" && args[0] !== null && "port" in args[0]) {
    const options = args[0] as net.ListenOptions;
    if (options.path === undefined && (options.host === undefined || WILDCARD_HOSTS.has(options.host))) {
      args[0] = { ...options, host: "127.0.0.1" };
    }
  }
  return (originalListen as (...listenArgs: unknown[]) => net.Server).apply(this, args);
};

// Binding to a concrete host resolves through dns.lookup, which lands the
// bind a tick later — but supertest reads address().port synchronously right
// after its internal listen(0). Hand its Test a loopback server plus a
// placeholder URL, and finalize the URL once that server is listening.
interface LoopbackTest {
  url: string;
  _server?: net.Server;
  _loopbackPath?: string;
  _loopbackProtocol?: string;
  serverAddress: (this: LoopbackTest, app: unknown, path: string) => string;
  end: (this: LoopbackTest, fn?: unknown) => unknown;
}

const require = createRequire(import.meta.url);
const SuperTest = require("supertest/lib/test.js") as { prototype: LoopbackTest };

const originalServerAddress = SuperTest.prototype.serverAddress;
SuperTest.prototype.serverAddress = function serverAddress(app, path) {
  const server = app as net.Server;
  if (typeof server.address !== "function" || server.address()) {
    return originalServerAddress.call(this, app, path);
  }
  this._server = server.listen(0, "127.0.0.1");
  this._loopbackPath = path;
  this._loopbackProtocol = server instanceof TlsServer ? "https" : "http";
  return `${this._loopbackProtocol}://127.0.0.1:0${path}`;
};

const originalEnd = SuperTest.prototype.end;
SuperTest.prototype.end = function end(fn) {
  const server = this._server;
  const finalize = (): unknown => {
    if (server && this._loopbackPath !== undefined) {
      const { port } = server.address() as net.AddressInfo;
      this.url = `${this._loopbackProtocol}://127.0.0.1:${port}${this._loopbackPath}`;
      this._loopbackPath = undefined;
    }
    return originalEnd.call(this, fn);
  };
  if (server && this._loopbackPath !== undefined && !server.listening) {
    server.once("listening", finalize);
    return this;
  }
  return finalize();
};
