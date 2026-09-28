#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BOOM 生命体征数据（Vital Data）读取测试工具

通过 USB Custom HID 读取 Flash 中的生命体征秒级数据（0x3A 开始读 + 0x3B 继续读），
分别测试两种查找/读取方向：
  - dir=0（向前）：逆时间序（最新 → 更早），从目标时间向更早的历史数据读
  - dir=1（向后）：顺时间序（最早 → 更晚），从目标时间向更晚读

协议依据：.claude/skills/boom-protocol（BOOM 状态说明）
工程源码：src/storage/storage_vital.c（0x3A/0x3B 处理）、src/ex_protocol.c（TLVC + DID 多帧）、
          src/wellness_utility.h（VitalData_Per_Second / vital_hrv_output_t）

用法：
    /c/miniconda3/python.exe readme/test_vital_hid.py                       # 最近 7 天，双向，导出 CSV+汇总
    /c/miniconda3/python.exe readme/test_vital_hid.py --last-days 1         # 最近 1 天
    /c/miniconda3/python.exe readme/test_vital_hid.py --dir 0 --last-days 7 # 仅向前
    /c/miniconda3/python.exe readme/test_vital_hid.py --dir 1 --last-days 7 # 仅向后
    /c/miniconda3/python.exe readme/test_vital_hid.py --time 1750000000     # 指定开始时间戳（忽略 --last-days）
    /c/miniconda3/python.exe readme/test_vital_hid.py --out mydata          # 指定导出文件前缀
    /c/miniconda3/python.exe readme/test_vital_hid.py --verbose             # 逐块打印明细
    /c/miniconda3/python.exe readme/test_vital_hid.py --diag                # 0x51 诊断（定位通信卡死）

导出文件（--out <prefix>，默认 vital_data）：
    <prefix>.dir0.seconds.csv  dir=0 向前 逐秒数据
    <prefix>.dir0.hrv.csv      dir=0 向前 每分钟 HRV
    <prefix>.dir1.seconds.csv  dir=1 向后 逐秒数据
    <prefix>.dir1.hrv.csv      dir=1 向后 每分钟 HRV
    <prefix>.summary.txt       人类可读汇总（时间范围/心率/HRV 统计）

依赖：
    pip install hid
"""

import struct
import sys
import time
import argparse
import csv
import os
from datetime import datetime, timezone

VID = 0x2FE3
PID = 0x03FF
REPORT_ID = 0x01
REPORT_SIZE = 64
TOTAL_REPORT_SIZE = REPORT_SIZE + 1

T_GET_VITAL = 0x3A          # 开始读生命体征数据
T_CONT_GET_VITAL = 0x3B     # 继续读生命体征数据
T_RET_VITAL = 0x3A          # 响应 T（0x3A / 0x3B 均回 0x3A）
T_DEBUG_STATUS = 0x51       # 诊断命令

MAX_MINUTES = 2             # 固件 MAX_MINUTES_PER_READ（storage_vital.h）

DIR_NAMES = {0: "向前(逆时间序, 最新→更早)", 1: "向后(顺时间序, 最早→更晚)"}

# 状态字节解码（VitalData_Per_Second.status：Bit5-3 行为类型，Bit2-0 活动状态）
BEHAVIOR_NAMES = {0: "休息", 1: "日常生活", 2: "步行", 3: "跑步", 4: "骑行", 5: "有氧运动", 6: "其他运动"}
ACTIVITY_NAMES = {0: "深度睡眠", 1: "浅度睡眠", 2: "其他睡眠", 3: "精神放松",
                  4: "活动量低", 5: "活动量高", 6: "精神兴奋", 7: "身体压力"}

# diag_status_t（60 字节，小端 packed，见 diag.h / readme/软件设计说明.md）
DIAG_FMT = "<IIIIIIIIBBHHHIIIIBBBB"
DIAG_SIZE = struct.calcsize(DIAG_FMT)
DIAG_MAGIC = 0x4D4F4F42  # "BOOM"
DIAG_FIELDS = [
    "magic", "uptime_ms", "heartbeat", "hid_rx_count", "hid_tx_submit",
    "hid_tx_done", "hid_tx_timeout", "hid_recover", "hid_in_ready",
    "async_pending", "async_stack_free", "low_stack_free",
    "high_stack_free", "async_exec", "async_last_tick", "async_full",
    "reset_reason", "app_step", "fw_major", "fw_minor", "fw_rev",
]


# ---------------------------------------------------------------------------
# 协议基础（与固件 modbus_crc / GetDataIdentifier 一致）
# ---------------------------------------------------------------------------

def crc16_modbus(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
    return crc & 0xFFFF


def make_did(start: bool, end: bool, seq: int, vdn: int) -> bytes:
    """2 字节 DataIdentifier：bit15=start, bit14=end, bit10-13=seq, bit0-9=vdn(本帧有效字节数)"""
    did = 0
    if start:
        did |= 1 << 15
    if end:
        did |= 1 << 14
    did |= (seq & 0x0F) << 10
    did |= vdn & 0x3FF
    return bytes([did & 0xFF, (did >> 8) & 0xFF])


def make_tlv_command(t: int, v: bytes = b"") -> bytes:
    """TLVC 命令帧：T(2) + L(2) + V + CRC16-MODBUS(2)"""
    body = struct.pack("<H", t) + struct.pack("<H", len(v)) + v
    crc = crc16_modbus(body)
    return body + struct.pack("<H", crc)


def make_out_report(t: int, v: bytes = b"") -> bytes:
    """构造完整 OUT 报告：Report ID(1) + DID(单帧) + TLVC + 补零到 64 字节"""
    tlv = make_tlv_command(t, v)
    did = make_did(True, True, 0, len(tlv))
    payload = did + tlv
    if len(payload) > REPORT_SIZE:
        raise ValueError(f"command payload too long: {len(payload)} > {REPORT_SIZE}")
    payload += bytes(REPORT_SIZE - len(payload))
    return bytes([REPORT_ID]) + payload


def find_device():
    import hid
    for d in hid.enumerate():
        if d["vendor_id"] == VID and d["product_id"] == PID:
            return d["path"], d.get("product_string", "Boom_Hid")
    return None, None


def reopen_device(hdev):
    """USB 重枚举后重新打开设备；返回新句柄，失败返回 None。"""
    try:
        hdev.close()
    except Exception:
        pass
    time.sleep(2.0)  # 等设备 USB 重新枚举完成
    path, _name = find_device()
    if not path:
        return None
    import hid
    d = hid.device()
    d.open_path(path)
    d.set_nonblocking(False)
    return d


# ---------------------------------------------------------------------------
# 多帧重组（按 DID 头，vdn = 本帧有效字节数，非总长）
# ---------------------------------------------------------------------------

def read_tlvc_frame(hdev, timeout_ms=2000):
    """按 DID 头重组一条可能跨多包的 TLVC 响应，返回 (T, V)；失败返回 (None, None)。

    每包 IN 报告 = [report_id][DID(2)][chunk(vdn)]...
    起始帧(bit15)重置缓冲；逐包追加载荷(chunk)；结束帧(bit14)返回整帧。
    """
    buf = bytearray()
    started = False
    deadline = time.time() + timeout_ms / 1000.0
    while True:
        remaining = deadline - time.time()
        if remaining <= 0:
            return None, None
        data = hdev.read(TOTAL_REPORT_SIZE, int(remaining * 1000))
        if not data:
            return None, None
        data = bytes(data)
        if len(data) < 3:
            continue
        p = data[1:]  # 去掉 Report ID
        did = p[0] | (p[1] << 8)
        start = bool(did & 0x8000)
        end = bool(did & 0x4000)
        vdn = did & 0x3FF
        chunk = p[2:2 + vdn]

        if start:
            buf = bytearray(chunk)
            started = True
        elif not started:
            continue  # 历史残留中间帧，丢弃
        else:
            buf += chunk

        if end:
            frame = bytes(buf)
            if len(frame) < 6:
                return None, None
            t = struct.unpack("<H", frame[0:2])[0]
            l = struct.unpack("<H", frame[2:4])[0]
            v = frame[4:4 + l]
            return t, v


# ---------------------------------------------------------------------------
# 生命体征响应解析
# ---------------------------------------------------------------------------

def parse_vital_response(v: bytes):
    """解析 0x3A 响应 V：
    start_time(4) dir(1) minutes(1) hrv(n*8) seconds((n*60-invalid)*6)
    """
    if len(v) < 6:
        return None
    start_time = struct.unpack("<I", v[0:4])[0]
    direction = v[4]
    minutes = v[5]

    off = 6
    hrv = []
    for _ in range(minutes):
        if off + 8 > len(v):
            break
        rmssd, sdnn = struct.unpack("<ff", v[off:off + 8])
        hrv.append((rmssd, sdnn))
        off += 8

    seconds = []
    while off + 6 <= len(v):
        hr = v[off]
        status = v[off + 1]
        pitch = v[off + 2]
        acc = v[off + 3]
        ppi = struct.unpack("<H", v[off + 4:off + 6])[0]
        seconds.append((hr, status, pitch, acc, ppi))
        off += 6

    return {
        "start_time": start_time,
        "dir": direction,
        "minutes": minutes,
        "hrv": hrv,
        "seconds": seconds,
    }


def _fmt_ts(ts: int) -> str:
    try:
        return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S") + " UTC"
    except (OverflowError, OSError, ValueError):
        return str(ts)


def _hrv_is_invalid(rmssd, sdnn) -> bool:
    return rmssd != rmssd or sdnn != sdnn  # NaN（全 FF）


def hr_state(hr: int) -> str:
    if 28 <= hr <= 240:
        return "有效"
    if hr in (0xFE, 0xFF):
        return "空白"
    return "无效"


def print_block(resp: dict, idx: int):
    d = resp["dir"]
    n_sec = len(resp["seconds"])
    hrs = [s[0] for s in resp["seconds"] if 28 <= s[0] <= 240]
    hr_stat = ""
    if hrs:
        hr_stat = f", 有效心率 avg={sum(hrs)/len(hrs):.1f} min={min(hrs)} max={max(hrs)}"
    print(f"[#{idx}] dir={d}({DIR_NAMES.get(d,'?')}) "
          f"start={resp['start_time']} ({_fmt_ts(resp['start_time'])}) "
          f"minutes={resp['minutes']} 秒数据={n_sec}{hr_stat}")

    for i, (rmssd, sdnn) in enumerate(resp["hrv"]):
        if _hrv_is_invalid(rmssd, sdnn):
            print(f"      HRV[{i}]: 无效")
        else:
            print(f"      HRV[{i}]: rmssd={rmssd:.2f} ms, sdnn={sdnn:.2f} ms")


# ---------------------------------------------------------------------------
# 读取流程（0x3A 开始 + 0x3B 继续，直到无数据或超时间范围）
# ---------------------------------------------------------------------------

def read_vital_flow(hdev, start_ts: int, direction: int, minutes: int, max_blocks: int,
                    stop_before=None, stop_after=None, verbose=False,
                    out_seconds=None, out_hrv=None):
    """执行一次完整的“开始读 + 继续读”流程，返回 (blocks, n_errors)。

    stop_before: dir=0 时，块开始时间早于此值则停止（读最近 N 天）。
    stop_after:  dir=1 时，块开始时间晚于此值则停止。
    out_seconds / out_hrv 为已打开的 csv.writer（可选），逐行写出。
    """
    minutes = max(1, min(minutes, MAX_MINUTES))
    blocks = []
    n_errors = 0

    # 0x3A 开始读：start_ts(4) + dir(1) + minutes(1)
    v = struct.pack("<I", start_ts & 0xFFFFFFFF) + bytes([direction, minutes])
    hdev.write(make_out_report(T_GET_VITAL, v))

    for idx in range(max_blocks):
        t, resp_v = read_tlvc_frame(hdev, timeout_ms=2000)
        if t is None:
            n_errors += 1
            print(f"  ! 第 {idx + 1} 次读取超时（可能已无响应/设备重启），中止")
            break
        if t != T_RET_VITAL:
            print(f"  ! 收到非生命体征响应 T=0x{t:02X}，丢弃重试")
            continue

        resp = parse_vital_response(resp_v)
        if resp is None:
            n_errors += 1
            print("  ! 响应解析失败（长度过短）")
            break

        # 时间范围判断（在写入前，避免越界块进入结果）
        if direction == 0 and stop_before is not None and resp["start_time"] < stop_before:
            print(f"  → 已早于 {_fmt_ts(stop_before)}（最近 {abs(int((time.time() - stop_before) / 86400))} 天），结束")
            break
        if direction == 1 and stop_after is not None and resp["start_time"] > stop_after:
            print(f"  → 已晚于 {_fmt_ts(stop_after)}，结束")
            break

        blocks.append(resp)
        if verbose:
            print_block(resp, idx + 1)
        elif (idx + 1) % 20 == 0:
            print(f"  ... 已读 {idx + 1} 块，当前 {_fmt_ts(resp['start_time'])}")

        # 逐秒写出
        if out_seconds is not None:
            base = resp["start_time"]
            for j, (hr, status, pitch, acc, ppi) in enumerate(resp["seconds"]):
                out_seconds.writerow([
                    base + j, _fmt_ts(base + j), hr, hr_state(hr),
                    BEHAVIOR_NAMES.get((status >> 3) & 0x7, "?"),
                    ACTIVITY_NAMES.get(status & 0x7, "?"),
                    pitch, acc, ppi])
        # HRV 逐分钟写出
        if out_hrv is not None:
            base = resp["start_time"]
            for j, (rmssd, sdnn) in enumerate(resp["hrv"]):
                out_hrv.writerow([
                    base + j * 60, _fmt_ts(base + j * 60),
                    "%.4f" % rmssd if not _hrv_is_invalid(rmssd, sdnn) else "",
                    "%.4f" % sdnn if not _hrv_is_invalid(rmssd, sdnn) else ""])

        if resp["start_time"] == 0:
            print("  → 已读到尽头（start_time=0）")
            break

        # 最后一批不再下发 0x3B，避免残留一个未读响应污染下一个方向的测试
        if idx + 1 >= max_blocks:
            print(f"  → 达到 --max-blocks 上限 {max_blocks}，提前结束")
            break

        # 0x3B 继续读：minutes(1)
        hdev.write(make_out_report(T_CONT_GET_VITAL, bytes([minutes])))

    return blocks, n_errors


def write_block_rows(out_sec, out_hrv, resp):
    """把一个响应块的逐秒 / 逐分钟 HRV 数据写入已打开的 csv writer。"""
    base = resp["start_time"]
    if out_sec is not None:
        for j, (hr, status, pitch, acc, ppi) in enumerate(resp["seconds"]):
            out_sec.writerow([base + j, _fmt_ts(base + j), hr, hr_state(hr),
                              BEHAVIOR_NAMES.get((status >> 3) & 0x7, "?"),
                              ACTIVITY_NAMES.get(status & 0x7, "?"),
                              pitch, acc, ppi])
    if out_hrv is not None:
        for j, (rmssd, sdnn) in enumerate(resp["hrv"]):
            out_hrv.writerow([base + j * 60, _fmt_ts(base + j * 60),
                              "%.4f" % rmssd if not _hrv_is_invalid(rmssd, sdnn) else "",
                              "%.4f" % sdnn if not _hrv_is_invalid(rmssd, sdnn) else ""])


def read_dir0_chunked(dev, start_ts, minutes, chunk_blocks, stop_before, max_total_blocks,
                      out_seconds=None, out_hrv=None):
    """dir=0（向前/逆时间序）分块读取：每读 chunk_blocks 个块就重连一次设备，
    避免长时间连续 HID 读取触发 USB 流控卡死 / 看门狗重枚举。
    dev 为单元素列表 [hdev]（重连时原地替换）。按 start_time 去重，最终时间递减返回。
    返回 (blocks, n_errors)。"""
    minutes = max(1, min(minutes, MAX_MINUTES))
    seen = {}
    n_errors = 0
    t0 = start_ts
    stall_streak = 0

    while len(seen) < max_total_blocks:
        hdev = dev[0]
        last_start = None
        ended = False

        try:
            hdev.write(make_out_report(T_GET_VITAL,
                                       struct.pack("<I", t0 & 0xFFFFFFFF) + bytes([0, minutes])))
            for _ in range(chunk_blocks):
                t, resp_v = read_tlvc_frame(hdev, timeout_ms=2000)
                if t is None:
                    n_errors += 1
                    break
                if t != T_RET_VITAL:
                    continue
                resp = parse_vital_response(resp_v)
                if resp is None:
                    n_errors += 1
                    break
                if resp["start_time"] == 0:
                    ended = True
                    break
                if stop_before is not None and resp["start_time"] < stop_before:
                    ended = True
                    break
                seen[resp["start_time"]] = resp
                last_start = resp["start_time"]
        except OSError:
            n_errors += 1  # 本块可能部分已读入 seen，last_start 保持最后的有效块

        if ended:
            break

        if last_start is None:
            stall_streak += 1
            if stall_streak >= 5:
                print("  ! 连续多块无进展，停止")
                break
            dev[0] = reopen_device(dev[0])
            if dev[0] is None:
                break
            continue

        stall_streak = 0
        # 下一 chunk 起点：last_start 所在扇区起点 + 600；重叠部分靠 seen 去重跳过
        t0 = (last_start // 600) * 600 + 600
        print(f"  [chunk] 累计 {len(seen)} 块，当前 {_fmt_ts(last_start)}，重连设备继续 ...")
        dev[0] = reopen_device(dev[0])
        if dev[0] is None:
            n_errors += 1
            break

    blocks = sorted(seen.values(), key=lambda b: b["start_time"], reverse=True)
    for resp in blocks:
        write_block_rows(out_seconds, out_hrv, resp)
    return blocks, n_errors


# ---------------------------------------------------------------------------
# 汇总统计（人类可读）
# ---------------------------------------------------------------------------

def summarize(blocks) -> dict:
    """从 blocks 列表汇总统计。"""
    stats = {"n_blocks": len(blocks), "n_seconds": 0, "n_valid_hr": 0,
             "hr_list": [], "rmssd_list": [], "sdnn_list": [],
             "min_ts": None, "max_ts": None}
    for b in blocks:
        base = b["start_time"]
        if base == 0:
            continue
        for j, (hr, _st, _p, _a, _ppi) in enumerate(b["seconds"]):
            ts = base + j
            stats["n_seconds"] += 1
            if stats["min_ts"] is None or ts < stats["min_ts"]:
                stats["min_ts"] = ts
            if stats["max_ts"] is None or ts > stats["max_ts"]:
                stats["max_ts"] = ts
            if 28 <= hr <= 240:
                stats["n_valid_hr"] += 1
                stats["hr_list"].append(hr)
        for rmssd, sdnn in b["hrv"]:
            if not _hrv_is_invalid(rmssd, sdnn):
                stats["rmssd_list"].append(rmssd)
                stats["sdnn_list"].append(sdnn)
    return stats


def fmt_range(min_ts, max_ts) -> str:
    if min_ts is None or max_ts is None:
        return "（无有效数据）"
    return f"{_fmt_ts(min_ts)} ~ {_fmt_ts(max_ts)}  (跨度 {max_ts - min_ts} 秒)"


def write_summary(path: str, results, last_days):
    """results: {0: blocks, 1: blocks}。写人类可读汇总。"""
    lines = []
    lines.append("BOOM 生命体征数据读取汇总")
    lines.append("=" * 60)
    if last_days:
        lines.append(f"读取范围：最近 {last_days} 天")
    lines.append("")

    for d in (0, 1):
        blocks = results[d]
        s = summarize(blocks)
        lines.append(f"方向 dir={d} —— {DIR_NAMES[d]}")
        lines.append(f"  响应块数      : {s['n_blocks']}")
        lines.append(f"  秒数据条数    : {s['n_seconds']}")
        lines.append(f"  有效心率条数  : {s['n_valid_hr']}")
        lines.append(f"  数据时间范围  : {fmt_range(s['min_ts'], s['max_ts'])}")
        if s["hr_list"]:
            lines.append(f"  心率(bpm)     : 平均 {sum(s['hr_list'])/len(s['hr_list']):.1f}，"
                         f"最低 {min(s['hr_list'])}，最高 {max(s['hr_list'])}")
        if s["rmssd_list"]:
            lines.append(f"  HRV RMSSD(ms) : 有效 {len(s['rmssd_list'])} 分钟，"
                         f"平均 {sum(s['rmssd_list'])/len(s['rmssd_list']):.2f}")
            lines.append(f"  HRV SDNN(ms)  : 有效 {len(s['sdnn_list'])} 分钟，"
                         f"平均 {sum(s['sdnn_list'])/len(s['sdnn_list']):.2f}")
        lines.append("")

    text = "\n".join(lines)
    print("\n" + text)
    with open(path, "w", encoding="utf-8-sig") as f:
        f.write(text)
    print(f"汇总已保存: {path}")


# ---------------------------------------------------------------------------
# 0x51 诊断（定位通信卡死）
# ---------------------------------------------------------------------------

def parse_diag_status(v: bytes) -> dict:
    if len(v) < DIAG_SIZE:
        v = v + bytes(DIAG_SIZE - len(v))
    return dict(zip(DIAG_FIELDS, struct.unpack(DIAG_FMT, v[:DIAG_SIZE])))


def print_diag(v: bytes):
    s = parse_diag_status(v)
    print("=" * 60)
    print("BOOM 运行诊断状态 (0x51)")
    print("=" * 60)
    print(f"  魔数        : 0x{s['magic']:08X} {'(OK)' if s['magic'] == DIAG_MAGIC else '(异常!)'}")
    print(f"  固件版本    : {s['fw_major']}.{s['fw_minor']}.{s['fw_rev']}")
    print(f"  运行时间    : {s['uptime_ms']} ms, 心跳 {s['heartbeat']}（每秒+1，冻结=卡死）")
    print(f"  应用状态机  : {s['app_step']}，复位原因 0x{s['reset_reason']:08X}")
    print(f"  HID 收/发   : rx={s['hid_rx_count']} submit={s['hid_tx_submit']} "
          f"done={s['hid_tx_done']} 拒绝={s['hid_tx_timeout']} in_ready={s['hid_in_ready']}")
    print(f"  USB 重枚举  : {s['hid_recover']} 次")
    print(f"  异步线程    : exec={s['async_exec']} pending={s['async_pending']}/10 "
          f"full={s['async_full']} 剩余栈={s['async_stack_free']}B")
    print(f"  线程剩余栈  : async={s['async_stack_free']} low={s['low_stack_free']} "
          f"high={s['high_stack_free']}")
    print("=" * 60)


def run_diag(hdev):
    hdev.write(make_out_report(T_DEBUG_STATUS))
    for i in range(8):
        t, v = read_tlvc_frame(hdev, timeout_ms=1000)
        if t is None:
            print(f"  第 {i+1} 次超时")
            continue
        if t != T_DEBUG_STATUS:
            print(f"  历史帧 T=0x{t:02X}，丢弃")
            continue
        if len(v) >= 4 and struct.unpack("<I", v[0:4])[0] != DIAG_MAGIC:
            print("  魔数不匹配，丢弃")
            continue
        print_diag(v)
        return True
    print("未收到 0x51 响应 —— 设备可能已完全无响应")
    return False


def run_diag_capture(hdev):
    """发送 0x51 并读取一次诊断状态，返回 dict；失败返回 None。"""
    try:
        hdev.write(make_out_report(T_DEBUG_STATUS))
    except Exception:
        return None
    for _ in range(8):
        t, v = read_tlvc_frame(hdev, timeout_ms=1000)
        if t is None or t != T_DEBUG_STATUS:
            continue
        s = parse_diag_status(v)
        if s["magic"] != DIAG_MAGIC:
            continue
        return s
    return None


def report_reset(before, after, n_errors):
    print("\n" + "=" * 60)
    print("重启检测结论")
    print("=" * 60)
    if before is None:
        print("读取前未获取到诊断基线，无法判断")
        print("=" * 60)
        return
    if after is None:
        print(f"读取后无法获取诊断（设备无响应/断开），且读取期间出现 {n_errors} 次读错误")
        print("→ 极可能读取过程中设备重启 / USB 重枚举")
        print("=" * 60)
        return

    reset_signs = []
    if after["uptime_ms"] < before["uptime_ms"]:
        reset_signs.append(f"uptime 由 {before['uptime_ms']}ms 变小为 {after['uptime_ms']}ms（运行时间被清零）")
    if after["hid_rx_count"] < before["hid_rx_count"]:
        reset_signs.append(f"hid_rx_count 由 {before['hid_rx_count']} 变小为 {after['hid_rx_count']}（收发计数被清零）")
    if after["heartbeat"] < before["heartbeat"]:
        reset_signs.append(f"heartbeat 由 {before['heartbeat']} 变小为 {after['heartbeat']}（心跳被清零）")
    if after["reset_reason"] != before["reset_reason"]:
        reset_signs.append(f"reset_reason 由 0x{before['reset_reason']:08X} 变为 0x{after['reset_reason']:08X}")

    reconn_signs = []
    if after["hid_recover"] > before["hid_recover"]:
        reconn_signs.append(f"USB 重枚举次数由 {before['hid_recover']} 增为 {after['hid_recover']}（HID IN 流控卡住 → 看门狗自愈重枚举）")

    if reset_signs:
        print("[!] 结论：读取过程中设备发生固件复位（MCU 重启）")
        for r in reset_signs:
            print(f"   * {r}")
    elif reconn_signs:
        print("[!] 结论：固件未复位，但读取过程中发生 USB 重枚举（自愈），导致读中断")
        for r in reconn_signs:
            print(f"   * {r}")
    else:
        print("[OK] 结论：未发现重启 / 重枚举")
        print(f"   uptime: {before['uptime_ms']} → {after['uptime_ms']} ms（递增，正常）")
        print(f"   hid_rx_count: {before['hid_rx_count']} → {after['hid_rx_count']}（递增，正常）")
        print(f"   reset_reason: 0x{after['reset_reason']:08X}（未变），hid_recover={after['hid_recover']}（未增）")

    if n_errors > 0:
        print(f"   （读取期间另有 {n_errors} 次读超时/解析失败）")
    print("=" * 60)


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def main():
    # 输出被重定向（管道/日志）时改用 UTF-8 便于查看；交互式 GBK 控制台保持不变
    try:
        if not sys.stdout.isatty():
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    ap = argparse.ArgumentParser(description="BOOM 生命体征数据读取测试（最近 N 天，双向）")
    ap.add_argument("--dir", type=int, default=None, choices=[0, 1],
                    help="0=向前(逆时间序) 1=向后(顺时间序)；缺省双向都测")
    ap.add_argument("--time", type=int, default=None,
                    help="开始时间戳（UTC 秒，缺省：dir0=当前时间 / dir1=最近N天起点）")
    ap.add_argument("--last-days", type=float, default=7.0,
                    help="读取最近多少天（默认 7；0 表示不限，读到无数据为止）")
    ap.add_argument("--minutes", type=int, default=2, help="每批读取分钟数（固件上限 2）")
    ap.add_argument("--max-blocks", type=int, default=10000, help="单方向最多继续读多少批")
    ap.add_argument("--chunk-blocks", type=int, default=100,
                    help="dir=0 分块读取：每块读多少批后重连设备（抗流控卡死，0=不分块）")
    ap.add_argument("--out", type=str, default="vital_data", help="导出文件前缀")
    ap.add_argument("--verbose", action="store_true", help="逐块打印明细")
    ap.add_argument("--diag", action="store_true", help="改为执行 0x51 诊断")
    args = ap.parse_args()

    import hid

    path, name = find_device()
    if path is None:
        print(f"未找到 VID=0x{VID:04X} PID=0x{PID:04X} 的设备，请检查 USB 连接")
        sys.exit(1)
    print(f"找到设备: {name} ({path})")

    hdev = hid.device()
    hdev.open_path(path)
    hdev.set_nonblocking(False)
    dev = [hdev]  # 分块读取重连时原地替换

    try:
        if args.diag:
            run_diag(hdev)
            return

        now = int(time.time())
        last_days = args.last_days if args.last_days > 0 else 0
        window_start = now - int(last_days * 86400) if last_days else None

        directions = [args.dir] if args.dir is not None else [0, 1]
        results = {0: [], 1: []}
        total_errors = 0

        # 读取前诊断基线（用于判断读取过程中是否重启）
        print("\n[诊断] 读取前基线 ...")
        baseline = run_diag_capture(hdev)
        if baseline:
            print(f"  uptime={baseline['uptime_ms']}ms  heartbeat={baseline['heartbeat']}  "
                  f"rx={baseline['hid_rx_count']}  recover={baseline['hid_recover']}  "
                  f"reset_reason=0x{baseline['reset_reason']:08X}")
        else:
            print("  ! 未获取到基线诊断")

        for d in directions:
            if args.time is not None:
                start_ts = args.time
            elif d == 0:
                start_ts = now
            else:
                start_ts = window_start if window_start is not None else 0

            stop_before = window_start if d == 0 else None
            stop_after = now if d == 1 else None

            print("\n" + "=" * 60)
            print(f"开始测试 dir={d}（{DIR_NAMES[d]}）")
            print(f"  开始时间戳 = {start_ts} ({_fmt_ts(start_ts)})"
                  + (f"，读到早于 {_fmt_ts(stop_before)} 为止" if stop_before else ""))
            print("=" * 60)

            sec_part = f"{args.out}.dir{d}.seconds.csv.part"
            hrv_part = f"{args.out}.dir{d}.hrv.csv.part"
            blocks = []
            n_errors = 0
            for attempt in range(1, 4):
                try:
                    f_sec = open(sec_part, "w", newline="", encoding="utf-8-sig")
                    f_hrv = open(hrv_part, "w", newline="", encoding="utf-8-sig")
                    out_sec = csv.writer(f_sec)
                    out_hrv = csv.writer(f_hrv)
                    out_sec.writerow(["unix_ts", "iso", "heart_rate", "hr_state",
                                      "behavior", "activity", "pitch", "acc", "ppi"])
                    out_hrv.writerow(["unix_ts", "iso", "rmssd", "sdnn"])

                    blocks, n_errors = read_vital_flow(hdev, start_ts, d, args.minutes, args.max_blocks,
                                                       stop_before=stop_before, stop_after=stop_after,
                                                       verbose=args.verbose, out_seconds=out_sec, out_hrv=out_hrv)
                    f_sec.close()
                    f_hrv.close()
                    # 完整读完后才原子改名，避免读中断破坏上一次的完整结果
                    os.replace(sec_part, f"{args.out}.dir{d}.seconds.csv")
                    os.replace(hrv_part, f"{args.out}.dir{d}.hrv.csv")
                    break
                except OSError as e:
                    print(f"  ! 第 {attempt} 次读取遇到 USB 读错误（{e}），设备可能重枚举，重连后重试 ...")
                    try:
                        f_sec.close()
                        f_hrv.close()
                    except Exception:
                        pass
                    newh = reopen_device(hdev)
                    if newh is None:
                        print("  ! 无法重新找到设备，中止该方向")
                        break
                    hdev = newh

            results[d] = blocks
            total_errors += n_errors
            s = summarize(blocks)
            print(f"dir={d} 完成：{s['n_blocks']} 块，共 {s['n_seconds']} 秒数据，"
                  f"有效心率 {s['n_valid_hr']} 条")
            print(f"  已导出: {args.out}.dir{d}.seconds.csv / {args.out}.dir{d}.hrv.csv")

        write_summary(f"{args.out}.summary.txt", results, last_days)

        # 读取后诊断，判断读取过程中是否重启
        print("\n[诊断] 读取后状态 ...")
        post = run_diag_capture(hdev)
        if post is None:
            print("  ! 当前句柄读取诊断失败，尝试重连设备 ...")
            try:
                hdev.close()
            except Exception:
                pass
            path2, name2 = find_device()
            if path2:
                try:
                    hdev2 = hid.device()
                    hdev2.open_path(path2)
                    hdev2.set_nonblocking(False)
                    post = run_diag_capture(hdev2)
                    if post:
                        print(f"  重连成功: {name2}")
                    hdev2.close()
                except Exception as e:
                    print(f"  重连失败: {e}")
            else:
                print("  ! 未找到设备")
        report_reset(baseline, post, total_errors)
    finally:
        try:
            hdev.close()
        except Exception:
            pass
        print("\n设备已关闭")


if __name__ == "__main__":
    main()
