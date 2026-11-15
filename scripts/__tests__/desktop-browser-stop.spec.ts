import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("closes Chromium through CDP, tolerates absence, and surfaces discovery, protocol and timeout failures", async () => {
  const script = resolve(__dirname, "../../desktop/rootfs/usr/local/bin/octo-desktop-stop");
  const { stdout } = await promisify(execFile)("python3", ["-c", `
import io, json, runpy, sys, types
from unittest.mock import Mock, patch
connection = Mock()
connection.recv.return_value = '{"id":1,"result":{}}'
websocket = types.SimpleNamespace(create_connection=Mock(return_value=connection), WebSocketConnectionClosedException=type("Closed", (Exception,), {}))
sys.modules["websocket"] = websocket
namespace = runpy.run_path(sys.argv[1])
close = namespace["close_browser"]
globals = close.__globals__
endpoint = "ws://127.0.0.1:9222/devtools/browser/fixture"
def version(): return io.StringIO(json.dumps({"webSocketDebuggerUrl": endpoint}))

with patch.dict(globals, browser_running=Mock(return_value=False)), patch("urllib.request.urlopen") as request:
    close()
    request.assert_not_called()

with patch.dict(globals, browser_running=Mock(side_effect=[True, False])), patch("urllib.request.urlopen", side_effect=lambda *a, **kw: version()):
    close()
    assert json.loads(connection.send.call_args.args[0]) == {"id": 1, "method": "Browser.close"}
    websocket.create_connection.assert_called_with(endpoint, timeout=3, suppress_origin=True)
    connection.close.assert_called_once()

with patch.dict(globals, browser_running=Mock(return_value=True)), patch("urllib.request.urlopen", side_effect=ConnectionRefusedError("CDP unreachable")):
    try: close(); raise AssertionError("unreachable CDP accepted while Chromium runs")
    except ConnectionRefusedError: pass

endpoint = "ws://192.0.2.10:9222/devtools/browser/foreign"
with patch.dict(globals, browser_running=Mock(return_value=True)), patch("urllib.request.urlopen", side_effect=lambda *a, **kw: version()):
    try: close(); raise AssertionError("non-loopback CDP accepted")
    except ValueError: pass

endpoint = "ws://127.0.0.1:9222/devtools/browser/fixture"
connection.recv.return_value = '{"id":1,"error":{"message":"refused"}}'
with patch.dict(globals, browser_running=Mock(return_value=True)), patch("urllib.request.urlopen", side_effect=lambda *a, **kw: version()):
    try: close(); raise AssertionError("CDP rejection swallowed")
    except RuntimeError: pass

connection.recv.return_value = '{"id":1,"result":{}}'
with patch.dict(globals, browser_running=Mock(return_value=True)), patch("urllib.request.urlopen", side_effect=lambda *a, **kw: version()), patch("time.monotonic", side_effect=[0, 13]):
    try: close(); raise AssertionError("stuck Chromium accepted")
    except TimeoutError: pass

with patch("subprocess.run", return_value=types.SimpleNamespace(returncode=2, stderr="cannot inspect processes")):
    try: namespace["browser_running"](); raise AssertionError("process inspection failure swallowed")
    except RuntimeError: pass
print(json.dumps({"cases": 7}))
`, script]);
  expect(stdout.trim().split("\n").at(-1)).toBe('{"cases": 7}');
});
