import http.server
import json
import time
from pathlib import Path


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        tools = [tool['function']['name'] for tool in request.get('tools', [])]
        messages = request.get('messages', [])
        completed = any(message.get('role') == 'tool' for message in messages)
        record = {'path': self.path, 'tools': tools, 'completed': completed}
        with Path('/home/node/results/model-requests.jsonl').open('a') as output:
            output.write(json.dumps(record) + '\n')
        delta = {'role': 'assistant'}
        if not completed and 'exec' in tools:
            command = "mkdir -p /home/node/workspace && node -e 'const fs=require(\"fs\");const rows=Array.from({length:10000},(_,i)=>({id:i,title:\"Task \"+i}));fs.writeFileSync(\"/home/node/workspace/tasks.json\",JSON.stringify(rows));console.log(rows.length)'"
            delta['tool_calls'] = [{'index': 0, 'id': 'call_benchmark_exec', 'type': 'function', 'function': {'name': 'exec', 'arguments': json.dumps({'command': command})}}]
            reason = 'tool_calls'
        else:
            delta['content'] = 'Benchmark tool turn complete.' if completed else 'Benchmark fixture did not receive the exec tool.'
            reason = 'stop'
        envelope = {'id': 'chatcmpl-hobby-benchmark', 'object': 'chat.completion.chunk', 'created': int(time.time()), 'model': 'fixture', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]}
        finish = {**envelope, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': reason}], 'usage': {'prompt_tokens': 100, 'completion_tokens': 50, 'total_tokens': 150}}
        body = ('data: ' + json.dumps(envelope) + '\n\ndata: ' + json.dumps(finish) + '\n\ndata: [DONE]\n\n').encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


http.server.ThreadingHTTPServer(('127.0.0.1', 18181), Handler).serve_forever()
