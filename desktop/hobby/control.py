import http.server
import json
import subprocess

FIXTURE = b'''<!doctype html><html><head><title>Hobby benchmark fixture</title></head><body style="font:24px sans-serif;padding:60px;background:#162430;color:white"><h1>Octogee Hobby VM</h1><label>Your message <input aria-label="Your message" id="message"></label><button onclick="document.querySelector('#result').textContent=document.querySelector('#message').value">Show on shared desktop</button><h2 id="result">Waiting</h2></body></html>'''


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            if self.path == '/screenshot':
                body = subprocess.check_output(['import', '-display', ':0', '-window', 'root', 'png:-'], timeout=20)
                mime = 'image/png'
            elif self.path == '/fixture':
                body, mime = FIXTURE, 'text/html'
            elif self.path == '/windows':
                rows = subprocess.check_output(['wmctrl', '-lx'], text=True, timeout=10).splitlines()
                windows = []
                for row in rows:
                    fields = row.split(None, 4)
                    if len(fields) == 5:
                        windows.append({'id': fields[0], 'class': fields[2], 'title': fields[4]})
                body, mime = json.dumps(windows).encode(), 'application/json'
            elif self.path == '/health':
                subprocess.run(['xdpyinfo'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
                body, mime = b'{"ok":true,"compositor":"openbox"}', 'application/json'
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as error:
            print(f'control error: {error}', flush=True)
            self.send_error(500)


http.server.ThreadingHTTPServer(('127.0.0.1', 7777), Handler).serve_forever()
