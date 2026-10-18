"""The robot window's local server.

Serves the page, keeps the speech queue and tells the open window what to do
over server-sent events. Speech is synthesized by the Silero server
(~/.claude/mods/silero-tts) in its "play": false mode: it hands back one WAV
per sentence and the page plays them itself, so the face follows the voice.

Endpoints (127.0.0.1 only; POST bodies must be application/json):
  GET  /                 the page and its files
  GET  /events           the event stream of the window
  GET  /wav/<name>.wav   a synthesized sentence from the Silero cache
  GET  /api/state        {listeners, level, status, owner}
  GET  /api/inbox?session=<id>   prompts typed or spoken in the window,
                         taken once, by the owner only           (token)
  POST /api/owner        {owner}                   the session the window
                                                   belongs to         (token)
  POST /api/prompt       {text}                    a prompt for Claude (token)
  POST /api/say          {text, speaker?, wait?, turn?}   409 when no window
                         listens; {muted: true} for a turn silenced already
  POST /api/message      {role, text}              the written conversation
  POST /api/status       {status}                  idle | thinking
  POST /api/level        {level}                   min | mid | max | full
  POST /api/greet                                  a greeting, once the window
                                                   has assembled      (token)
  POST /api/done         {job}                     the window played a job out
  POST /api/stop                                   silence, drop the queue
Exits after IDLE_SECONDS with no window listening.

The person talks to the robot through Handy, a dictation app. The server
follows Handy's log: the moment it starts recording, the robot falls silent
as on Esc, and whatever it was about to say until the recording ends is
silenced with its turn, so it never talks over the person.

The window belongs to one Claude session, the one that ran /robot last (kept
in settings.json, so a restart keeps it): only that session takes its prompts,
and only its X-Robot-Session header gets an answer, a status or speech in.
With no owner on record, any session may.

Prompts reach a Claude session that may run without permission prompts, so
the two prompt endpoints want the token the server writes to .token (mode
600) and hands its own page; every request must name this host, which keeps
DNS rebinding out, and a POST from a browser must come from this origin.
"""
from __future__ import annotations

import hmac
import itertools
import json
import os
import queue
from urllib.parse import parse_qs, urlsplit
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = "127.0.0.1"
PORT = int(os.environ.get("ROBOT_PORT", "47219"))
HERE = Path(__file__).resolve().parent
SILERO = Path.home() / ".claude" / "mods" / "silero-tts"
TTS_SOCKET = SILERO / "tts.sock"
TTS_CACHE = SILERO / "cache"
SETTINGS = HERE / "settings.json"
# The mod reads the default port's token; a test server elsewhere keeps its own.
TOKEN_FILE = HERE / (".token" if PORT == 47219 else f".token-{PORT}")
ALLOWED_HOSTS = {f"{HOST}:{PORT}", f"localhost:{PORT}"}

LEVELS = ("min", "mid", "max", "full")
STATUSES = ("idle", "thinking")
MAX_BODY = 512 * 1024
MAX_PROMPT = 20000
HISTORY = 60
IDLE_SECONDS = 15 * 60
# The Silero server exits after 30 idle minutes and takes seconds to load its
# model again: while a window is open it is asked for a cached word this often.
WARM_SECONDS = 10 * 60
WARM_TEXT = "Да."
# What the robot says once its window has assembled: one at random, never the
# one it said last. Plain Russian only, so the voice reads them as written.
GREETINGS = (
    "Здорово, братан! Собрался нахрен по винтику, ни одной лишней детали. Говори, чего херачим.",
    "Ёпта, я живой! Ну всё, держись, сейчас будем творить дичь.",
    "Ну здарова! Голос прогрет, мозги разогреты, жопа в кресле. Погнали, блять.",
    "Опа, кто проснулся? Я проснулся. Хер его знает зачем, но давай уже работать.",
    "Всё, сука, собрался. Чуть гайку не просрал, но хрен с ней. Что делаем?",
    "Здорово, брат! Кофе не пью, спать не хочу, баги ебашу без выходных. Выкладывай.",
    "Так, бля, тишина в гараже! Робот на связи. Что сломалось на этот раз?",
    "Приветствую, командир! Боеготовность полная, похуизм на нуле. Ставь задачу.",
    "Ну нихуя себе, меня опять собрали. Ладно, раз уж собрали, давай чего-нибудь замутим.",
    "Здорово, братишка! Я в строю, руки чешутся, железо гудит. Давай, ебашим.",
)
WAV_NAME = re.compile(r"^[0-9a-f]{24}\.wav$")
STATIC = {
    "/robot.js": ("robot.js", "text/javascript; charset=utf-8"),
    "/kinds.js": ("kinds.js", "text/javascript; charset=utf-8"),
    "/palette.js": ("palette.js", "text/javascript; charset=utf-8"),
    "/figure.js": ("figure.js", "text/javascript; charset=utf-8"),
    "/landscape.js": ("landscape.js", "text/javascript; charset=utf-8"),
    "/scene.js": ("scene.js", "text/javascript; charset=utf-8"),
    "/ui.js": ("ui.js", "text/javascript; charset=utf-8"),
    "/head.js": ("head.js", "text/javascript; charset=utf-8"),
    "/rain.js": ("rain.js", "text/javascript; charset=utf-8"),
    "/alive.js": ("alive.js", "text/javascript; charset=utf-8"),
    "/monitor.js": ("monitor.js", "text/javascript; charset=utf-8"),
    "/status.js": ("status.js", "text/javascript; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/sounds/transform.mp3": ("sounds/transform.mp3", "audio/mpeg"),
    "/sounds/impact.mp3": ("sounds/impact.mp3", "audio/mpeg"),
    "/fonts/FeatureMono-Regular.woff2": ("fonts/FeatureMono-Regular.woff2", "font/woff2"),
    "/fonts/FeatureMono-Medium.woff2": ("fonts/FeatureMono-Medium.woff2", "font/woff2"),
    "/fonts/NextArt-SemiBold.woff2": ("fonts/NextArt-SemiBold.woff2", "font/woff2"),
}


# What only the window's owner may post: the mod's own reports of its session.
FROM_THE_OWNER = ("/api/say", "/api/message", "/api/status", "/api/action", "/api/vitals")
# What the monitor keeps: the last calls, and how long a call's subject may be.
ACTIONS = 8
ACTION_STATES = ("run", "ok", "fail")
TEXT_LIMIT = 120
SESSION_ID = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
# A turn's id, as the mod names the answer its speech belongs to.
TURN_ID = SESSION_ID
# How many silenced turns are remembered: only the latest ever speak again.
MUTED = 16

# Handy's log; ROBOT_HANDY_LOG points a test server at a log of its own.
HANDY_LOG = Path(
    os.environ.get("ROBOT_HANDY_LOG", Path.home() / "Library" / "Logs" / "com.pais.handy" / "handy.log")
)
# A recording starting: the talk key's action (a debug line) and the
# microphone opening ~0.2 s later (an info line, kept at a quieter log level).
HANDY_STARTS = re.compile(r"TranscribeAction::start called|Microphone stream initialized")
# A recording over: released, cancelled or transcribed.
HANDY_ENDS = re.compile(
    r"TranscribeAction::stop called|Microphone stream stopped"
    r"|Unregistered handy-keys shortcut: cancel|Transcription completed in"
)
HANDY_POLL_SECONDS = 0.05
# The most of the log read at a time.
HANDY_CHUNK = 256 * 1024
# How long the robot keeps quiet after a recording starts when its end never
# shows in the log.
HEARING_SECONDS = 60


def is_session(value: object) -> bool:
    return isinstance(value, str) and bool(SESSION_ID.match(value))


def log(*parts: object) -> None:
    print(time.strftime("%H:%M:%S"), *parts, file=sys.stderr, flush=True)


# ------------------------------------------------------------------ state


class Hub:
    """Everything the windows share: listeners, settings, history, the queue."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.listeners: dict[int, queue.Queue] = {}
        self.ids = itertools.count(1)
        self.jobs = itertools.count(1)
        self.history: list[dict] = []
        self.status = "idle"
        self.settings: dict = {"level": "mid", "owner": None}
        self.waits: dict[int, threading.Event] = {}
        self.pending: queue.Queue = queue.Queue()
        self.generation = 0  # bumped by stop: jobs of an older one are dropped
        # The answer the speech heard last belongs to, and the answers silenced:
        # an answer said while it is written keeps sending words after a stop.
        self.speaking_turn: str | None = None
        self.muted: tuple[str, ...] = ()
        # Until when the person is speaking, in monotonic seconds: 0 when not.
        self.hearing_until = 0.0
        self.last_listener = time.monotonic()
        self.token = secrets.token_urlsafe(24)
        self.instance = secrets.token_hex(6)  # a page from another run reloads
        self.inbox: list[str] = []
        self.window_sent: list[str] = []  # typed here, not yet echoed by the mod
        self.actions: list[dict] = []  # the monitor's feed, newest last
        self.vitals: dict | None = None  # the session's last figures
        self._load_settings()

    # settings ------------------------------------------------------------

    def _load_settings(self) -> None:
        try:
            saved = json.loads(SETTINGS.read_text("utf-8"))
        except (OSError, ValueError):
            return
        if saved.get("level") in LEVELS:
            self.settings = {**self.settings, "level": saved["level"]}
        if is_session(saved.get("owner")):
            self.settings = {**self.settings, "owner": saved["owner"]}
        greeting = saved.get("greeting")
        if isinstance(greeting, int) and 0 <= greeting < len(GREETINGS):
            self.settings = {**self.settings, "greeting": greeting}

    def _save_settings(self, changes: dict) -> None:
        with self.lock:
            self.settings = {**self.settings, **changes}
            snapshot = dict(self.settings)
        try:
            SETTINGS.write_text(json.dumps(snapshot), "utf-8")
        except OSError as error:
            log("settings not saved:", error)

    def set_level(self, level: str) -> None:
        self._save_settings({"level": level})
        self.broadcast("level", {"level": level})

    def set_owner(self, owner: str) -> None:
        self._save_settings({"owner": owner})
        log("the window belongs to session", owner[:8])

    def is_owner(self, session: str | None) -> bool:
        """Whether this session may drive the window: its owner, or anyone while it has none."""
        with self.lock:
            owner = self.settings["owner"]
        return owner is None or session == owner

    # listeners -------------------------------------------------------------

    def add_listener(self) -> tuple[int, queue.Queue]:
        inbox: queue.Queue = queue.Queue()
        with self.lock:
            older = list(self.listeners.items())
            listener = next(self.ids)
            self.listeners = {listener: inbox}
            self.last_listener = time.monotonic()
        # One window speaks: an older one goes quiet and says so.
        for _, old in older:
            old.put(("replaced", {}))
        return listener, inbox

    def remove_listener(self, listener: int) -> None:
        with self.lock:
            self.listeners = {k: v for k, v in self.listeners.items() if k != listener}
            self.last_listener = time.monotonic()
            alone = not self.listeners
        if alone:
            self.release_all()

    def listening(self) -> int:
        with self.lock:
            return len(self.listeners)

    def broadcast(self, event: str, data: dict) -> None:
        with self.lock:
            inboxes = list(self.listeners.values())
        for inbox in inboxes:
            inbox.put((event, data))

    # conversation ----------------------------------------------------------

    def add_message(self, role: str, text: str) -> None:
        message = {"role": role, "text": text, "at": time.time()}
        with self.lock:
            # A prompt typed in the window is shown when sent; the mod's echo
            # of it, when its turn starts, is not shown twice.
            if role == "user" and text in self.window_sent:
                index = self.window_sent.index(text)
                self.window_sent = self.window_sent[:index] + self.window_sent[index + 1:]
                return
            self.history = [*self.history, message][-HISTORY:]
        self.broadcast("message", message)

    def queue_prompt(self, text: str) -> None:
        log(f"a prompt from the window, {len(text)} characters")
        message = {"role": "user", "text": text, "at": time.time()}
        with self.lock:
            self.inbox = [*self.inbox, text]
            self.window_sent = [*self.window_sent, text][-20:]
            self.history = [*self.history, message][-HISTORY:]
        self.broadcast("message", message)

    def take_inbox(self, session: str | None) -> list[str]:
        if not self.is_owner(session):
            return []
        with self.lock:
            taken, self.inbox = self.inbox, []
        if taken:
            log(f"{len(taken)} prompt(s) to session {(session or '?')[:8]}")
        return taken

    def set_status(self, status: str) -> None:
        with self.lock:
            self.status = status
        self.broadcast("status", {"status": status})

    def hello(self) -> dict:
        with self.lock:
            return {
                "instance": self.instance,
                "level": self.settings["level"],
                "status": self.status,
                "history": list(self.history),
                "actions": list(self.actions),
                "vitals": self.vitals,
            }

    # monitor ---------------------------------------------------------------

    def add_action(self, action: dict) -> None:
        """A call started or ended: a started one joins the feed, an ended one updates its row."""
        with self.lock:
            known = any(one["id"] == action["id"] for one in self.actions)
            if known:
                self.actions = [{**one, "state": action["state"]} if one["id"] == action["id"] else one for one in self.actions]
            else:
                self.actions = [*self.actions, action][-ACTIONS:]
        self.broadcast("action", action)

    def set_vitals(self, vitals: dict) -> None:
        with self.lock:
            self.vitals = vitals
        self.broadcast("vitals", vitals)

    # speech ----------------------------------------------------------------

    def greet(self) -> int:
        """Says a greeting other than the last one; the job."""
        last = self.settings.get("greeting")
        choice = secrets.choice([i for i in range(len(GREETINGS)) if i != last])
        self._save_settings({"greeting": choice})
        job, _done = self.enqueue(GREETINGS[choice], "eugene")
        return job

    def is_muted(self, turn: str | None) -> bool:
        """Whether `turn` is silenced. While the person speaks everything is,
        and a turn that tries to speak then stays silenced."""
        with self.lock:
            if time.monotonic() < self.hearing_until:
                if turn is not None and turn not in self.muted:
                    self.muted = (*self.muted, turn)[-MUTED:]
                return True
            return turn is not None and turn in self.muted

    def hear(self) -> None:
        """The person started speaking: silence now, and until they are done."""
        with self.lock:
            self.hearing_until = time.monotonic() + HEARING_SECONDS
        self.stop()

    def heard(self) -> None:
        """The person stopped speaking: the robot may talk again."""
        with self.lock:
            self.hearing_until = 0.0

    def hearing(self) -> bool:
        with self.lock:
            return time.monotonic() < self.hearing_until

    def enqueue(self, text: str, speaker: str, turn: str | None = None) -> tuple[int, threading.Event]:
        job = next(self.jobs)
        done = threading.Event()
        with self.lock:
            self.waits = {**self.waits, job: done}
            generation = self.generation
            if turn is not None:
                self.speaking_turn = turn
        self.pending.put((job, text, speaker, generation))
        return job, done

    def finish(self, job: int) -> None:
        with self.lock:
            done = self.waits.get(job)
            self.waits = {k: v for k, v in self.waits.items() if k != job}
        if done is not None:
            done.set()

    def release_all(self) -> None:
        with self.lock:
            waits = list(self.waits.values())
            self.waits = {}
        for done in waits:
            done.set()

    def stop(self) -> None:
        with self.lock:
            self.generation += 1
            if self.speaking_turn is not None:
                self.muted = (*self.muted, self.speaking_turn)[-MUTED:]
                self.speaking_turn = None
        self.release_all()
        self.broadcast("stop", {})

    def current(self, generation: int) -> bool:
        with self.lock:
            return generation == self.generation


HUB = Hub()


# ------------------------------------------------------------------ Silero


def start_tts() -> None:
    """Starts the Silero server the way speak.py does, if it is not up."""
    python = SILERO / "venv" / "bin" / "python"
    with open(SILERO / "server.log", "ab") as out:
        subprocess.Popen(
            [str(python), str(SILERO / "server.py")],
            stdin=subprocess.DEVNULL,
            stdout=out,
            stderr=out,
            start_new_session=True,
            cwd=str(SILERO),
        )


# Held while the Silero server is being started: two threads must not start two.
TTS_START = threading.Lock()


def connect_tts() -> socket.socket:
    def attempt() -> socket.socket:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            client.connect(str(TTS_SOCKET))
        except OSError:
            client.close()
            raise
        return client

    try:
        return attempt()
    except OSError:
        pass
    with TTS_START:
        try:
            return attempt()
        except OSError:
            start_tts()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            time.sleep(0.2)
            try:
                return attempt()
            except OSError:
                continue
    raise OSError("the Silero server did not come up")


def warm_voice() -> None:
    """Has the Silero server up with its model loaded, and the greetings in its cache."""
    text = " ".join((WARM_TEXT, *GREETINGS))
    request = json.dumps({"text": text, "play": False}, ensure_ascii=False) + "\n"
    try:
        with connect_tts() as client:
            client.settimeout(60)
            client.sendall(request.encode("utf-8"))
            for raw in client.makefile("r", encoding="utf-8"):
                if raw.strip() in ("ok", "error", ""):
                    break
    except OSError as error:
        log("could not warm the voice:", error)


def warm_watch() -> None:
    while True:
        time.sleep(WARM_SECONDS)
        if HUB.listening() > 0:
            warm_voice()


def synthesize(job: int, text: str, speaker: str, generation: int) -> int:
    """Streams the job's sentences to the window as they are ready; the count."""
    count = 0
    request = json.dumps({"text": text, "speaker": speaker, "play": False}) + "\n"
    with connect_tts() as client:
        client.settimeout(180)
        client.sendall(request.encode("utf-8"))
        for raw in client.makefile("r", encoding="utf-8"):
            line = raw.strip()
            if line in ("ok", ""):
                break
            if line == "error":
                raise OSError("Silero could not synthesize the text")
            if not HUB.current(generation):
                break
            part = json.loads(line)
            name = Path(part["wav"]).name
            HUB.broadcast(
                "part", {"job": job, "index": count, "text": part["text"], "url": f"/wav/{name}"}
            )
            count += 1
    return count


def speaker_loop() -> None:
    while True:
        job, text, speaker, generation = HUB.pending.get()
        if not HUB.current(generation) or HUB.listening() == 0:
            HUB.finish(job)
            continue
        try:
            count = synthesize(job, text, speaker, generation)
        except (OSError, ValueError, KeyError) as error:
            log("speech failed:", error)
            HUB.broadcast("fail", {"message": "Голос не отвечает: " + str(error)})
            count = 0
        if count == 0 or not HUB.current(generation):
            HUB.finish(job)
        else:
            HUB.broadcast("end", {"job": job, "count": count})


def idle_watch(server: ThreadingHTTPServer) -> None:
    while True:
        time.sleep(30)
        with HUB.lock:
            quiet = not HUB.listeners and time.monotonic() - HUB.last_listener > IDLE_SECONDS
        if quiet:
            log("no window for a while, exiting")
            server.shutdown()
            return


class LogTail:
    """The whole lines a log gains. What it held when first seen is skipped;
    a log rotated or cut short is read again from its start."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.seen = False
        self.inode = 0
        self.position = 0
        self.rest = b""

    def lines(self) -> list[str]:
        try:
            stat = self.path.stat()
        except OSError:
            return []
        if not self.seen:
            self.seen = True
            self.inode, self.position = stat.st_ino, stat.st_size
            return []
        if stat.st_ino != self.inode or stat.st_size < self.position:
            self.inode, self.position, self.rest = stat.st_ino, 0, b""
        if stat.st_size == self.position:
            return []
        try:
            with self.path.open("rb") as file:
                file.seek(self.position)
                chunk = file.read(HANDY_CHUNK)
        except OSError:
            return []
        self.position += len(chunk)
        *whole, rest = (self.rest + chunk).split(b"\n")
        self.rest = rest[-HANDY_CHUNK:]
        return [line.decode("utf-8", "replace") for line in whole]


def handy_watch() -> None:
    """Keeps the robot quiet while Handy records the person speaking."""
    tail = LogTail(HANDY_LOG)
    while True:
        time.sleep(HANDY_POLL_SECONDS)
        for line in tail.lines():
            # One recording logs two starts: the second must not silence again.
            if HANDY_STARTS.search(line) and not HUB.hearing():
                log("the person is speaking: silent")
                HUB.hear()
            elif HANDY_ENDS.search(line):
                HUB.heard()


# ------------------------------------------------------------------ HTTP


class Handler(BaseHTTPRequestHandler):
    server_version = "robot/0.1"

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        if os.environ.get("ROBOT_DEBUG"):
            log(self.address_string(), format % args)

    # helpers ---------------------------------------------------------------

    def send_json(self, status: int, data: dict) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path: Path, kind: str, cache: bool) -> None:
        try:
            body = path.read_bytes()
        except OSError:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "max-age=86400" if cache else "no-store")
        self.end_headers()
        self.wfile.write(body)

    def host_ok(self) -> bool:
        """Only requests naming this host: a rebound domain gets nothing."""
        if self.headers.get("Host") in ALLOWED_HOSTS:
            return True
        self.send_json(HTTPStatus.FORBIDDEN, {"error": "foreign host"})
        return False

    def token_ok(self) -> bool:
        given = self.headers.get("X-Robot-Token", "")
        if hmac.compare_digest(given.encode(), HUB.token.encode()):
            return True
        self.send_json(HTTPStatus.UNAUTHORIZED, {"error": "bad token"})
        return False

    def send_page(self) -> None:
        try:
            page = (HERE / "index.html").read_text("utf-8")
        except OSError:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        page = page.replace("__ROBOT_TOKEN__", HUB.token).replace("__ROBOT_INSTANCE__", HUB.instance)
        body = page.encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict | None:
        """The request's JSON object, or None after answering why not."""
        # A JSON content type makes a browser on another site ask first, and
        # nothing here answers that question: only local tools get through.
        kind = self.headers.get("Content-Type", "")
        origin = self.headers.get("Origin")
        if not kind.startswith("application/json"):
            self.send_json(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"error": "json only"})
            return None
        if origin is not None and origin != f"http://{HOST}:{PORT}":
            self.send_json(HTTPStatus.FORBIDDEN, {"error": "foreign origin"})
            return None
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            self.send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "too large"})
            return None
        try:
            data = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "bad json"})
            return None
        if not isinstance(data, dict):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "an object is expected"})
            return None
        return data

    # GET -------------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        if not self.host_ok():
            return
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            self.send_page()
        elif path == "/api/inbox":
            if self.token_ok():
                session = parse_qs(urlsplit(self.path).query).get("session", [None])[0]
                self.send_json(HTTPStatus.OK, {"prompts": HUB.take_inbox(session)})
        elif path == "/events":
            self.stream_events()
        elif path == "/api/state":
            with HUB.lock:
                state = {
                    "listeners": len(HUB.listeners),
                    "level": HUB.settings["level"],
                    "status": HUB.status,
                    "owner": HUB.settings["owner"],
                }
            self.send_json(HTTPStatus.OK, state)
        elif path.startswith("/wav/"):
            name = path[len("/wav/"):]
            if not WAV_NAME.match(name):
                self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
                return
            self.send_file(TTS_CACHE / name, "audio/wav", cache=True)
        elif path in STATIC:
            file, kind = STATIC[path]
            self.send_file(HERE / file, kind, cache=path.startswith(("/fonts/", "/sounds/")))
        else:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def stream_events(self) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        listener, inbox = HUB.add_listener()
        log("window", listener, "connected")
        # The first answer must not wait for the model to load.
        threading.Thread(target=warm_voice, daemon=True).start()
        inbox.put(("hello", HUB.hello()))
        try:
            while True:
                try:
                    event, data = inbox.get(timeout=15)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                payload = json.dumps(data, ensure_ascii=False)
                self.wfile.write(f"event: {event}\ndata: {payload}\n\n".encode("utf-8"))
                self.wfile.flush()
                if event == "replaced":
                    return
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            HUB.remove_listener(listener)
            log("window", listener, "gone")

    # POST ------------------------------------------------------------------

    def do_POST(self) -> None:  # noqa: N802
        if not self.host_ok():
            return
        path = self.path.split("?", 1)[0]
        if path in ("/api/prompt", "/api/owner", "/api/greet") and not self.token_ok():
            return
        if path in FROM_THE_OWNER and not HUB.is_owner(self.headers.get("X-Robot-Session")):
            self.send_json(HTTPStatus.CONFLICT, {"error": "the window belongs to another session"})
            return
        data = self.read_json()
        if data is None:
            return
        handler = {
            "/api/owner": self.post_owner,
            "/api/prompt": self.post_prompt,
            "/api/say": self.post_say,
            "/api/message": self.post_message,
            "/api/status": self.post_status,
            "/api/action": self.post_action,
            "/api/vitals": self.post_vitals,
            "/api/level": self.post_level,
            "/api/greet": self.post_greet,
            "/api/done": self.post_done,
            "/api/stop": self.post_stop,
        }.get(path)
        if handler is None:
            self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        handler(data)

    def post_owner(self, data: dict) -> None:
        owner = data.get("owner")
        if not is_session(owner):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "owner: a session id"})
            return
        HUB.set_owner(owner)
        self.send_json(HTTPStatus.OK, {})

    def post_prompt(self, data: dict) -> None:
        text = str(data.get("text") or "").strip()
        if not text or len(text) > MAX_PROMPT:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": f"text of 1..{MAX_PROMPT} characters"})
            return
        HUB.queue_prompt(text)
        self.send_json(HTTPStatus.OK, {})

    def post_say(self, data: dict) -> None:
        text = str(data.get("text") or "").strip()
        speaker = str(data.get("speaker") or "eugene")
        turn = data.get("turn")
        if not text:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "no text"})
            return
        if not re.fullmatch(r"[a-z_]{2,20}", speaker):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "bad speaker"})
            return
        if turn is not None and not (isinstance(turn, str) and TURN_ID.fullmatch(turn)):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "bad turn"})
            return
        if HUB.listening() == 0:
            self.send_json(HTTPStatus.CONFLICT, {"error": "no window"})
            return
        if HUB.is_muted(turn):
            self.send_json(HTTPStatus.OK, {"muted": True})
            return
        job, done = HUB.enqueue(text, speaker, turn)
        if data.get("wait"):
            # Generous: a long answer read whole takes minutes.
            done.wait(timeout=60 + len(text) * 0.15)
        self.send_json(HTTPStatus.OK, {"job": job})

    def post_message(self, data: dict) -> None:
        role = data.get("role")
        text = str(data.get("text") or "")
        if role not in ("user", "assistant") or not text.strip():
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "role and text"})
            return
        HUB.add_message(role, text)
        self.send_json(HTTPStatus.OK, {})

    def post_status(self, data: dict) -> None:
        status = data.get("status")
        if status not in STATUSES:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "bad status"})
            return
        HUB.set_status(status)
        self.send_json(HTTPStatus.OK, {})

    def post_action(self, data: dict) -> None:
        action = {
            "id": str(data.get("id") or "")[:80],
            "tool": str(data.get("tool") or "")[:40],
            "detail": str(data.get("detail") or "")[:TEXT_LIMIT],
            "state": data.get("state"),
            "sub": data.get("sub") is True,
            "at": time.time(),
        }
        if not action["id"] or not action["tool"] or action["state"] not in ACTION_STATES:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "id, tool and state"})
            return
        HUB.add_action(action)
        self.send_json(HTTPStatus.OK, {})

    def post_vitals(self, data: dict) -> None:
        def number(value: object) -> float | None:
            return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None

        limits = data.get("limits") if isinstance(data.get("limits"), list) else []
        vitals = {
            "context": number(data.get("context")),
            "tokens": number(data.get("tokens")),
            "window": number(data.get("window")),
            "limits": [
                {"kind": str(one.get("kind") or "")[:20], "used": number(one.get("used")), "resets": number(one.get("resets"))}
                for one in limits[:4]
                if isinstance(one, dict) and number(one.get("used")) is not None
            ],
            "usd": number(data.get("usd")),
            "ageMs": number(data.get("ageMs")),
            "model": str(data.get("model") or "")[:60],
            "at": time.time(),
        }
        HUB.set_vitals(vitals)
        self.send_json(HTTPStatus.OK, {})

    def post_level(self, data: dict) -> None:
        level = data.get("level")
        if level not in LEVELS:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "bad level"})
            return
        HUB.set_level(level)
        self.send_json(HTTPStatus.OK, {})

    def post_greet(self, _data: dict) -> None:
        if HUB.listening() == 0:
            self.send_json(HTTPStatus.CONFLICT, {"error": "no window"})
            return
        if HUB.hearing():
            self.send_json(HTTPStatus.OK, {"muted": True})
            return
        self.send_json(HTTPStatus.OK, {"job": HUB.greet()})

    def post_done(self, data: dict) -> None:
        try:
            HUB.finish(int(data.get("job")))
        except (TypeError, ValueError):
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "bad job"})
            return
        self.send_json(HTTPStatus.OK, {})

    def post_stop(self, _data: dict) -> None:
        HUB.stop()
        self.send_json(HTTPStatus.OK, {})


class Server(ThreadingHTTPServer):
    def handle_error(self, request, client_address) -> None:
        # A window reloading drops its requests mid-way: not worth a traceback.
        if isinstance(sys.exc_info()[1], (ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


def main() -> int:
    try:
        server = Server((HOST, PORT), Handler)
    except OSError as error:
        log("cannot listen:", error)
        return 1
    server.daemon_threads = True
    TOKEN_FILE.write_text(HUB.token, "utf-8")
    os.chmod(TOKEN_FILE, 0o600)
    threading.Thread(target=speaker_loop, daemon=True).start()
    threading.Thread(target=idle_watch, args=(server,), daemon=True).start()
    threading.Thread(target=warm_watch, daemon=True).start()
    threading.Thread(target=handy_watch, daemon=True).start()
    log(f"robot server on http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
