"""Complete raw retrieval and sample means; all query intervals are [start, end)."""
import math
import time
import hashlib
from collections import OrderedDict
from copy import deepcopy
from threading import BoundedSemaphore, Lock
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from datetime import datetime, timedelta, timezone

import requests

UTC = timezone.utc
SHANGHAI = timezone(timedelta(hours=8))
FIELDS = tuple(f"field{i}" for i in range(1, 9))
MAX_RANGE = timedelta(days=366)
PAGE_LIMIT = 8000
MAX_SAMPLES = 500_000
CACHE_TTL = 15
CACHE_SIZE = 8
_cache = OrderedDict()
_cache_lock = Lock()
# requests' read timeout is an idle timeout, not a wall-clock deadline.
# Bound both the caller's wait and outstanding HTTP work (including slow trickles).
_http_pool = ThreadPoolExecutor(max_workers=8)
_http_slots = BoundedSemaphore(8)


def _read_payload(url, params, timeout):
    response = requests.get(url, params=params, timeout=timeout)
    try:
        response.raise_for_status()
        return response.json()
    finally:
        response.close()


def request_payload(url, params, budget):
    timeout = budget.request_timeout()
    if not _http_slots.acquire(blocking=False):
        raise AggregationError("聚合服务繁忙，请稍后重试", 503, "aggregation_busy")
    try:
        future = _http_pool.submit(_read_payload, url, params, timeout)
    except Exception:
        _http_slots.release()
        raise
    future.add_done_callback(lambda _: _http_slots.release())
    try:
        return future.result(timeout=budget.check())
    except FutureTimeout:
        future.cancel()
        raise AggregationError("聚合总超时，请缩小时间范围", 504, "aggregation_timeout") from None


def cached_result(key):
    with _cache_lock:
        now = time.monotonic()
        for expired in [item for item, (deadline, _) in _cache.items() if deadline <= now]:
            del _cache[expired]
        if key not in _cache:
            return None
        _cache.move_to_end(key)
        return deepcopy(_cache[key][1])


def cache_result(key, result):
    with _cache_lock:
        _cache[key] = (time.monotonic() + CACHE_TTL, deepcopy(result))
        _cache.move_to_end(key)
        while len(_cache) > CACHE_SIZE:
            _cache.popitem(last=False)


class AggregationError(Exception):
    def __init__(self, message, status=502, code="aggregation_incomplete"):
        super().__init__(message)
        self.status = status
        self.code = code


def parse_time(value):
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if result.tzinfo is None:
            result = result.replace(tzinfo=UTC)
        return result.astimezone(UTC)
    except (AttributeError, TypeError, ValueError, OverflowError):
        raise AggregationError("聚合需要有效的 ISO start 和 end 时间", 400, "invalid_range") from None


def iso(value):
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def validate_range(start, end):
    if start >= end or end - start > MAX_RANGE:
        raise AggregationError("聚合时间范围须大于 0 且不超过 366 天", 400, "invalid_range")
    # Leave room for rounding the final calendar bucket.
    if start.year < 2 or end.year >= 9999:
        raise AggregationError("聚合时间超出支持范围", 400, "invalid_range")


class RequestBudget:
    """One budget for an entire API call, including all shared sources."""
    def __init__(self, max_requests=128, total_seconds=30):
        self.remaining = max_requests
        self.deadline = time.monotonic() + total_seconds

    def check(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise AggregationError("聚合总超时，请缩小时间范围", 504, "aggregation_timeout")
        return remaining

    def request_timeout(self):
        remaining = self.check()
        if self.remaining <= 0:
            raise AggregationError("聚合请求预算耗尽，请缩小时间范围")
        self.remaining -= 1
        return min(15, remaining)


def bucket_start(value, mode):
    local = value.astimezone(SHANGHAI).replace(minute=0, second=0, microsecond=0)
    if mode in {"day", "month"}:
        local = local.replace(hour=0)
    if mode == "month":
        local = local.replace(day=1)
    return local


def bucket_next(value, mode):
    if mode == "month":
        return value.replace(year=value.year + (value.month == 12), month=value.month % 12 + 1)
    return value + timedelta(hours=1) if mode == "hour" else value + timedelta(days=1)


def aggregate(source, base_url, start, end, mode, budget=None):
    if mode not in {"hour", "day", "month"}:
        raise AggregationError("不支持的 aggregation", 400, "invalid_aggregation")
    validate_range(start, end)
    budget = budget or RequestBudget()
    budget.check()
    cache_key = (base_url, str(source["channel_id"]),
                 hashlib.sha256((source["read_api_key"] or "").encode()).digest(), start, end, mode)
    cached = cached_result(cache_key)
    if cached is not None:
        return cached
    channel, samples = {}, {}
    # ThingSpeak filters at second precision. Round outward, then filter locally.
    left = start.replace(microsecond=0)
    right = end.replace(microsecond=0)
    if right < end:
        right += timedelta(seconds=1)
    pending = []
    while left < right:
        stop = min(left + timedelta(days=7), right)
        pending.append((left, stop))
        left = stop
    while pending:
        lo, hi = pending.pop()
        params = {"start": iso(lo), "end": iso(hi), "results": PAGE_LIMIT, "offset": 0}
        if source["read_api_key"]:
            params["api_key"] = source["read_api_key"]
        try:
            payload = request_payload(
                f"{base_url}/channels/{source['channel_id']}/feeds.json", params, budget
            )
        except (requests.RequestException, ValueError):
            # Never include upstream URLs: they can contain the read API key.
            raise AggregationError("无法完整读取 ThingSpeak 原始数据") from None
        budget.check()
        if not isinstance(payload, dict) or not isinstance(payload.get("feeds"), list):
            raise AggregationError("ThingSpeak 返回无效数据，无法确认完整性")
        feeds = payload["feeds"]
        if len(feeds) >= PAGE_LIMIT:
            seconds = int((hi - lo).total_seconds())
            if seconds <= 1:
                raise AggregationError("ThingSpeak 单秒数据达到 8000 条，无法确认完整性")
            midpoint = lo + timedelta(seconds=seconds // 2)
            # Saturated parent pages are discarded; only complete leaves contribute.
            pending.extend(((lo, midpoint), (midpoint, hi)))
            continue
        if not isinstance(payload.get("channel"), dict):
            raise AggregationError("ThingSpeak 返回无效 channel")
        channel = payload["channel"]
        for index, feed in enumerate(feeds):
            if index % 1024 == 0:
                budget.check()
            if not isinstance(feed, dict):
                raise AggregationError("ThingSpeak 返回无效样本")
            try:
                timestamp = parse_time(feed.get("created_at"))
            except AggregationError:
                raise AggregationError("ThingSpeak 样本时间无效，无法确认完整性") from None
            if not start <= timestamp < end:
                continue
            entry_id = feed.get("entry_id")
            if not isinstance(entry_id, (int, str)) or isinstance(entry_id, bool) or not str(entry_id).isdigit():
                raise AggregationError("ThingSpeak 样本缺少有效 entry_id，无法可靠去重")
            key = str(int(entry_id))
            if key in samples and samples[key] != (timestamp, feed):
                raise AggregationError("ThingSpeak 重复样本内容不一致，请重试")
            samples[key] = (timestamp, feed)
            if len(samples) > MAX_SAMPLES:
                raise AggregationError("聚合样本预算耗尽，请缩小时间范围")
    buckets = {}
    cursor = bucket_start(start, mode)
    while cursor < end:
        stop = bucket_next(cursor, mode)
        buckets[cursor] = {
            "created_at": iso(cursor), "bucket_end": iso(stop),
            "range_start": iso(max(cursor, start)), "range_end": iso(min(stop, end)),
            "partial": cursor < start or stop > end,
            "counts": dict.fromkeys(FIELDS, 0),
            **{field: [] for field in FIELDS},
        }
        cursor = stop
    for index, (timestamp, feed) in enumerate(samples.values()):
        if index % 1024 == 0:
            budget.check()
        bucket = buckets[bucket_start(timestamp, mode)]
        for field in FIELDS:
            raw = feed.get(field)
            if isinstance(raw, bool):
                continue
            try:
                value = float(raw)
            except (TypeError, ValueError, OverflowError):
                continue
            if math.isfinite(value):
                bucket[field].append(value)
    for bucket in buckets.values():
        budget.check()
        for field in FIELDS:
            values = bucket[field]
            count = len(values)
            bucket["counts"][field] = count
            # Normalize before summing, so even finite near-float-limit values
            # cannot overflow an intermediate sum. Clamp rounding to the bounds.
            scale = max((abs(value) for value in values), default=0)
            if not count:
                bucket[field] = None
            elif not scale:
                bucket[field] = 0.0
            else:
                fraction = math.fsum(value / scale for value in values) / count
                bucket[field] = min(1.0, max(-1.0, fraction)) * scale
    budget.check()
    result = {"channel": channel, "feeds": list(buckets.values()), "aggregation": {
        "mode": mode, "time_zone": "Asia/Shanghai", "start": iso(start), "end": iso(end),
        "sample_count": len(samples),
    }}
    cache_result(cache_key, result)
    budget.check()
    return result
