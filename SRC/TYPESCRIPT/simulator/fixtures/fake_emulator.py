"""Test double for launch-all.test.ts: answers /state like an emulator, prints a line, exits on terminate."""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

port = int(sys.argv[sys.argv.index("--map-port") + 1])
vendor = sys.argv[sys.argv.index("--vendor") + 1]
caps = sys.argv[sys.argv.index("--capitals") + 1].split(",")


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        body = json.dumps({"devices": [{"name": c, "alpha": c, "lat": 1.0, "lon": 2.0, "vendor": vendor} for c in caps],
                           "links": [], "totals": {"users": 56, "users_calling": 1, "ports": 106, "calls": 1, "devices": len(caps)},
                           "scenario": {"name": "normal"}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


print("fake emulator for %s on :%d" % (vendor, port), flush=True)
print("this DeprecationWarning line is filtered", flush=True)
HTTPServer(("127.0.0.1", port), H).serve_forever()
