import json
import os
import re
import sys
from pathlib import Path

from pytubefix import YouTube

MAX_BYTES = 500 * 1024 * 1024
DEFAULT_CLIENTS = ["ANDROID_VR", "IOS", "TV", "WEB_CREATOR", "WEB"]


def proxy_config():
    proxy = os.environ.get("YOUTUBE_PROXY", "").strip()
    if not proxy:
        return None
    return {"http": proxy, "https": proxy}


def client_candidates():
    configured = os.environ.get("PYTUBEFIX_CLIENTS", "").strip()
    single = os.environ.get("PYTUBEFIX_CLIENT", "").strip()
    values = []
    if configured:
        values.extend(x.strip().upper() for x in configured.split(",") if x.strip())
    if single:
        values.append(single.upper())
    values.extend(DEFAULT_CLIENTS)

    seen = set()
    result = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            result.append(value)
    return result


def make_youtube(url: str, client: str) -> YouTube:
    kwargs = {}
    proxies = proxy_config()
    if proxies:
        kwargs["proxies"] = proxies
    return YouTube(url, client=client, **kwargs)


def resolution_value(value):
    match = re.search(r"(\d+)", str(value or ""))
    return int(match.group(1)) if match else 0


def safe_attr(obj, name, default=None):
    try:
        value = getattr(obj, name)
        return default if value is None else value
    except Exception:
        return default


def short_error(exc):
    text = str(exc or "").replace("\n", " ").strip()
    return text[:420] + ("..." if len(text) > 420 else "")


def with_working_client(url: str, operation):
    errors = []
    for client in client_candidates():
        try:
            yt = make_youtube(url, client)
            return operation(yt, client)
        except Exception as exc:
            msg = short_error(exc)
            errors.append(f"{client}: {msg}")
            print(f"[pytubefix] {client} failed: {msg}", file=sys.stderr)

    joined = " | ".join(errors[-5:])
    raise RuntimeError(f"all pytubefix clients failed ({joined})")


def build_inspect_result(yt: YouTube, client: str, url: str):
    streams = yt.streams
    formats = []

    for stream in streams:
        try:
            if not safe_attr(stream, "includes_video_track", False):
                continue
            height = resolution_value(safe_attr(stream, "resolution", ""))
            if not height:
                continue
            has_audio = bool(safe_attr(stream, "includes_audio_track", False))
            formats.append({
                "format_id": str(safe_attr(stream, "itag", f"pf-{height}")),
                "url": safe_attr(yt, "watch_url", url),
                "height": height,
                "vcodec": safe_attr(stream, "video_codec", "video") or "video",
                "acodec": (safe_attr(stream, "audio_codec", "audio") or "audio") if has_audio else "none",
                "ext": safe_attr(stream, "subtype", "mp4") or "mp4",
                "has_drm": False,
            })
        except Exception:
            continue

    try:
        audio = streams.get_audio_only()
    except Exception:
        audio = None
    if audio:
        formats.append({
            "format_id": str(safe_attr(audio, "itag", "pf-audio")),
            "url": safe_attr(yt, "watch_url", url),
            "height": None,
            "vcodec": "none",
            "acodec": safe_attr(audio, "audio_codec", "audio") or "audio",
            "ext": "m4a",
            "has_drm": False,
        })

    if not formats:
        raise RuntimeError("no downloadable stream was exposed")

    return {
        "id": safe_attr(yt, "video_id", None),
        "title": safe_attr(yt, "title", "YouTube video"),
        "uploader": safe_attr(yt, "author", "YouTube"),
        "channel": safe_attr(yt, "author", "YouTube"),
        "thumbnail": safe_attr(yt, "thumbnail_url", None),
        "duration": safe_attr(yt, "length", None),
        "availability": "public",
        "age_limit": 0,
        "is_live": False,
        "live_status": "not_live",
        "formats": formats,
        "extractor": "pytubefix",
        "extractor_key": "Pytubefix",
        "pytubefix_client": client,
    }


def inspect_video(url: str):
    return with_working_client(url, lambda yt, client: build_inspect_result(yt, client, url))


def choose_video_stream(yt: YouTube, max_height: int):
    candidates = []
    try:
        candidates = yt.streams.filter(progressive=True, file_extension="mp4").all()
    except Exception:
        candidates = []

    eligible = []
    for stream in candidates:
        h = resolution_value(safe_attr(stream, "resolution", ""))
        if h and h <= max_height:
            eligible.append((h, stream))

    if eligible:
        eligible.sort(key=lambda item: item[0])
        return eligible[-1][1]

    try:
        stream = yt.streams.get_highest_resolution()
    except Exception:
        stream = None
    if not stream:
        raise RuntimeError("could not find a progressive MP4 stream")
    return stream


def ensure_size(stream):
    try:
        size = int(stream.filesize or 0)
    except Exception:
        size = 0
    if size and size > MAX_BYTES:
        raise RuntimeError("selected YouTube stream is larger than the 500 MB limit")


def output_file_from_template(template: str, ext: str) -> Path:
    if not template:
        raise RuntimeError("missing output template")
    final_path = template.replace("%(ext)s", ext)
    path = Path(final_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def download_with_client(yt: YouTube, client: str, output_template: str, mode: str, max_height: int):
    if mode == "audio":
        stream = yt.streams.get_audio_only()
        if not stream:
            raise RuntimeError("could not find an audio stream")
        ext = "m4a"
    else:
        stream = choose_video_stream(yt, max_height)
        ext = safe_attr(stream, "subtype", "mp4") or "mp4"
        if ext not in {"mp4", "webm"}:
            ext = "mp4"

    ensure_size(stream)
    target = output_file_from_template(output_template, ext)
    result = stream.download(
        output_path=str(target.parent),
        filename=target.name,
        skip_existing=False,
        timeout=30,
        max_retries=2,
    )

    final_path = Path(result) if result else target
    if not final_path.exists():
        raise RuntimeError("download finished without creating the requested file")
    if final_path.stat().st_size > MAX_BYTES:
        try:
            final_path.unlink()
        except Exception:
            pass
        raise RuntimeError("prepared YouTube file is larger than the 500 MB limit")

    return {"path": str(final_path), "engine": "pytubefix", "client": client}


def download_video(url: str, output_template: str, mode: str, max_height: int):
    return with_working_client(
        url,
        lambda yt, client: download_with_client(yt, client, output_template, mode, max_height),
    )


def main():
    if len(sys.argv) < 3:
        raise RuntimeError("Usage: pytubefix_bridge.py <inspect|download> <url> [output] [mode] [height]")

    action = sys.argv[1]
    url = sys.argv[2]

    if action == "inspect":
        print(json.dumps(inspect_video(url), ensure_ascii=False))
        return

    if action == "download":
        if len(sys.argv) < 5:
            raise RuntimeError("Download requires output template and mode")
        output_template = sys.argv[3]
        mode = sys.argv[4]
        max_height = int(sys.argv[5]) if len(sys.argv) > 5 else 720
        print(json.dumps(download_video(url, output_template, mode, max_height), ensure_ascii=False))
        return

    raise RuntimeError(f"Unknown action: {action}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"pytubefix fallback failed: {short_error(exc)}", file=sys.stderr)
        sys.exit(1)
