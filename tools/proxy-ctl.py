#!/usr/bin/env python3
"""通过 mihomo 控制 socket 管理代理节点（代理挂掉时用于恢复）。
用法:
  python3 tools/proxy-ctl.py ls                      # 列出代理组与当前节点
  python3 tools/proxy-ctl.py test [N]                # 对节点做延迟测试（默认每组 50 个）
  python3 tools/proxy-ctl.py switch <组名> <节点名>    # 切换 Selector 组
  python3 tools/proxy-ctl.py heal                    # 测试并自动把所有 Selector 组切到最快的可用节点
"""
import json, subprocess, sys, urllib.parse

SOCK = "/tmp/verge/verge-mihomo.sock"
BASE = "http://localhost"


def curl(path, method="GET", data=None, timeout=20):
    cmd = ["curl", "-s", "-m", str(timeout), "--unix-socket", SOCK]
    if method != "GET":
        cmd += ["-X", method, "-H", "Content-Type: application/json", "-d", json.dumps(data or {})]
    cmd += [BASE + path]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    try:
        return json.loads(out)
    except Exception:
        return {"__raw": out[:200]}


def proxies():
    return curl("/proxies").get("proxies", {})


def groups_of(px):
    return {k: v for k, v in px.items() if v.get("type") in ("Selector", "URLTest", "Fallback", "LoadBalance")}


TEST_URL = urllib.parse.quote("https://www.google.com/generate_204", safe="")


def delay(name):
    d = curl(f"/proxies/{urllib.parse.quote(name)}/delay?timeout=4000&url={TEST_URL}", timeout=30)
    return d.get("delay") if isinstance(d, dict) else None


def do_ls():
    px = proxies()
    for name, g in groups_of(px).items():
        print(f"[{g['type']}] {name}  now={g.get('now')}  ({len(g.get('all', []))} 节点)")
        for n in g.get("all", [])[:8]:
            h = px.get(n, {}).get("history", [])
            print(f"    - {n}  {h[-1] if h else ''}")


def do_test(n=50):
    px = proxies()
    seen, ok = set(), []
    for name, g in groups_of(px).items():
        if g["type"] != "Selector":
            continue
        for node in g.get("all", [])[:n]:
            if node in seen or node in ("DIRECT", "REJECT", "GLOBAL"):
                continue
            seen.add(node)
            d = delay(node)
            if d:
                ok.append((d, node, name))
                print(f"OK  {d:>6}ms  {node}  ({name})")
            else:
                print(f"..  --     {node}")
    ok.sort()
    print("\n最快:", [x[1] for x in ok[:5]] if ok else "全部不可用")
    return ok


def do_switch(group, node):
    r = curl(f"/proxies/{urllib.parse.quote(group)}", "PUT", {"name": node})
    now = curl(f"/proxies/{urllib.parse.quote(group)}").get("now")
    print(f"{group} -> {now}  (resp={r})")


def do_heal():
    ok = do_test(60)
    if not ok:
        print("没有可用节点，需要用户在 Clash Verge 里更新订阅")
        return 1
    best = ok[0][1]
    px = proxies()
    for name, g in groups_of(px).items():
        if g["type"] == "Selector":
            do_switch(name, best)
    print(f"\n已把全部 Selector 组切到 {best}")
    return 0


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "ls"
    if cmd == "ls":
        do_ls()
    elif cmd == "test":
        do_test(int(sys.argv[2]) if len(sys.argv) > 2 else 50)
    elif cmd == "switch":
        do_switch(sys.argv[2], sys.argv[3])
    elif cmd == "heal":
        sys.exit(do_heal())
