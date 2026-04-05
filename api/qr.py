from http import HTTPStatus
from http.server import BaseHTTPRequestHandler
from io import BytesIO
from urllib.parse import parse_qs, urlparse

import qrcode
import qrcode.image.svg


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        params = parse_qs(urlparse(self.path).query)
        text = (params.get("text") or [""])[0]
        if not text:
            self.send_response(HTTPStatus.BAD_REQUEST)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"Missing text query parameter.")
            return

        image = qrcode.make(text, image_factory=qrcode.image.svg.SvgImage, box_size=8, border=2)
        buffer = BytesIO()
        image.save(buffer)
        body = buffer.getvalue()

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "image/svg+xml")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "public, max-age=300")
        self.end_headers()
        self.wfile.write(body)
