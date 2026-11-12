# Fake Node daemon for daemon_launch tests: `fake_daemon.py serve --data-dir D --app-version V --cwd /`.
# Serves daemon:status on the socket path bootstrap.cjs derives, records each start, exits after 20 s.
import hashlib, json, os, socket, sys, threading, time
args = sys.argv[1:]
data = args[args.index("--data-dir") + 1]
version = args[args.index("--app-version") + 1]
with open(os.path.join(data, "starts.log"), "a") as f:
    f.write(json.dumps({"pid": os.getpid(), "version": version, "argv": args, "electron": os.environ.get("ELECTRON_RUN_AS_NODE"), "bin": os.environ.get("MILAGRE_BUNDLED_BIN_DIR"), "sid": os.getsid(0) == os.getpid()}) + "\n")
directory = f"/tmp/milagre-{os.getuid()}"
os.makedirs(directory, mode=0o700, exist_ok=True)
path = os.path.join(directory, hashlib.sha256(data.encode()).hexdigest()[:24] + ".sock")
try:
    os.unlink(path)
except FileNotFoundError:
    pass
server = socket.socket(socket.AF_UNIX)
server.bind(path)
server.listen(8)
def serve(conn):
    with conn:
        reader = conn.makefile("rb")
        for line in reader:
            frame = json.loads(line)
            result = {"pid": os.getpid(), "version": version, "protocolVersion": 1, "closing": False, "dataDir": data}
            conn.sendall((json.dumps({"v": 1, "id": frame["id"], "result": result}) + "\n").encode())
def stop():
    time.sleep(20)
    os.unlink(path)
    os._exit(0)
threading.Thread(target=stop, daemon=True).start()
import signal
def term(*_):
    try:
        os.unlink(path)
    finally:
        os._exit(0)
signal.signal(signal.SIGTERM, term)
while True:
    conn, _ = server.accept()
    threading.Thread(target=serve, args=(conn,), daemon=True).start()
