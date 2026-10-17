#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
墨读 · 本地服务
1. 托管静态文件（用 http:// 打开，IndexedDB 才能稳定工作）
2. /api/llm 反向代理（绕过浏览器跨域限制，让你的 API Key 只在本地流转）
"""
import json
import os
import socket
import sys
import threading
import webbrowser
import urllib.request
import urllib.error
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
START_PORT = 8765
MAX_PORT = 8785


def lan_ip():
    """取本机局域网 IP（不会真的发包）"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return "127.0.0.1"
    finally:
        s.close()


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        try:
            code = str(args[1]) if len(args) > 1 else ""
            if code.startswith(("4", "5")):
                sys.stderr.write("  ! %s\n" % (fmt % args))
        except Exception:
            pass

    def end_headers(self):
        # 静态资源不缓存，改完代码刷新即生效
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    # ── 健康检查 ──
    def do_GET(self):
        if self.path.split("?")[0] == "/api/ping":
            body = b'{"ok":true,"name":"modu-reader"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    # ── LLM 代理 ──
    def do_POST(self):
        if self.path.split("?")[0] != "/api/llm":
            self.send_error(404, "Not Found")
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length)
            body = json.loads(raw.decode("utf-8"))
        except Exception as e:
            self._json_error(400, "请求体解析失败: %s" % e)
            return

        target = str(body.pop("_target", "")).rstrip("/")
        key = body.pop("_key", "") or self.headers.get("Authorization", "").replace("Bearer ", "")

        if not target.startswith(("http://", "https://")):
            self._json_error(400, "缺少有效的接口地址")
            return

        url = target if target.endswith("/chat/completions") else target + "/chat/completions"

        req = urllib.request.Request(
            url,
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer %s" % key,
                "Accept": "text/event-stream",
                "User-Agent": "modu-reader/1.0",
            },
            method="POST",
        )

        try:
            resp = urllib.request.urlopen(req, timeout=300)
        except urllib.error.HTTPError as e:
            data = e.read()
            try:
                self.send_response(e.code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except Exception:
                pass
            return
        except Exception as e:
            self._json_error(502, "无法连接模型服务：%s" % e)
            return

        ctype = resp.headers.get("Content-Type", "text/event-stream")
        try:
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Accel-Buffering", "no")
            if "event-stream" in ctype:
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                while True:
                    chunk = resp.read(256)
                    if not chunk:
                        break
                    self.wfile.write(("%X\r\n" % len(chunk)).encode() + chunk + b"\r\n")
                    self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            else:
                data = resp.read()
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            try:
                sys.stderr.write("  ! 转发中断: %s\n" % e)
            except Exception:
                pass
        finally:
            try:
                resp.close()
            except Exception:
                pass

    def _json_error(self, code, msg):
        data = json.dumps({"error": {"message": msg}}, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception:
            pass


def find_port(host):
    for port in range(START_PORT, MAX_PORT + 1):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((host, port))
                return port
            except OSError:
                continue
    return START_PORT


def main():
    local_only = "--local" in sys.argv
    host = "127.0.0.1" if local_only else "0.0.0.0"
    port = find_port(host)
    url = "http://127.0.0.1:%d/" % port
    phone_url = "http://%s:%d/" % (lan_ip(), port)

    print("")
    print("  ┌──────────────────────────────────────────────┐")
    print("  │   墨 读  ·  MODU READER                      │")
    print("  └──────────────────────────────────────────────┘")
    print("")
    print("   电脑访问   %s" % url)
    if local_only:
        print("   手机访问   已关闭（--local 模式）")
    else:
        print("   手机访问   %s" % phone_url)
        print("              手机与电脑连同一个 Wi-Fi，用手机浏览器打开上面这行")
    print("")
    print("   数据保存在浏览器里；手机是独立书库，不自动同步。")
    print("   关闭此窗口即退出。")
    print("")

    try:
        server = ThreadingHTTPServer((host, port), Handler)
    except OSError as e:
        print("  启动失败：%s" % e)
        try:
            input("  按回车退出…")
        except EOFError:
            pass
        return

    if "--no-browser" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  已退出。")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
