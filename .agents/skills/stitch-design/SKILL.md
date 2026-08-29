---
name: stitch-design
description: Generate UI design screens with the Stitch MCP (design systems, screen generation, variants), including the direct-API workaround for the generation timeouts that the local stitch-mcp proxy causes. Use whenever working with the stitch MCP tools.
whenToUse: When the user asks to design or redesign a screen with Stitch, or when any stitch MCP tool fails with "Request timed out" (MCP error -32001) or list_screens returns empty for a project that has screens
---

The stitch MCP is configured in `~/.kimi-code/mcp.json` as
`npx @_davideast/stitch-mcp proxy` with `STITCH_API_KEY` in its env. The proxy
forwards to a **stateless** Streamable HTTP MCP server at
`https://stitch.googleapis.com/mcp`.

## Normal flow (try the MCP tools first)

1. `create_project` → note the project id.
2. `create_design_system` then `update_design_system` to attach it (retry once
   on "service unavailable" — that error is transient).
3. `generate_screen_from_text` with `designSystem`, `deviceType`
   (DESKTOP/MOBILE), and a detailed prompt.
4. Download results: screenshot `downloadUrl` (append `=w1440` for full
   resolution) and `htmlCode.downloadUrl` (the generated HTML).

## Known failure modes (hit repeatedly, Aug 2026)

- **`generate_screen_from_text` (and `edit_screens` / `generate_variants`)
  die with MCP error -32001 "Request timed out".** Generation takes ~90–120 s
  server-side; the local proxy gives up well before that and the screen never
  lands. Retrying through the proxy never works, and polling `list_screens`
  afterwards shows nothing. This is a proxy timeout, not a Stitch outage.
- **`list_screens` returns `{}` even for projects that have screens** — broken
  server-side, same result via the proxy and direct calls. Do not rely on it.
  `get_project` and `get_screen` (with an id captured at generation time) work.

## The workaround: call the Stitch endpoint directly

Skip the proxy. The endpoint is stateless — no initialize handshake or session
headers needed, plain JSON in/out, and you control the timeout.

```bash
KEY=$(python3 -c "import json;print(json.load(open('$HOME/.kimi-code/mcp.json'))['mcpServers']['stitch']['env']['STITCH_API_KEY'])")

curl -sS --max-time 600 -o result.json \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "X-Goog-Api-Key: $KEY" \
  -d '{
    "jsonrpc": "2.0", "id": 1, "method": "tools/call",
    "params": {
      "name": "generate_screen_from_text",
      "arguments": {
        "projectId": "<PROJECT_ID>",
        "deviceType": "DESKTOP",
        "designSystem": "assets/<ASSET_ID>",
        "prompt": "..."
      }
    }
  }' \
  https://stitch.googleapis.com/mcp
```

Rules that make this reliable:

- **Run it as a background task** with a generous shell timeout; expect
  ~100 s per screen. Desktop and mobile generations can run as two parallel
  background tasks against the same project.
- **Capture the screen `name` / `id` from the response immediately** and write
  it down (e.g. into the file you save the design assets in). Because
  `list_screens` is broken, the id in the generation response is the only
  handle you get for later `get_screen` / `edit_screens` / `generate_variants`
  calls.
- The response nests twice: `result.content[0].text` is a JSON string; parse
  it and read `outputComponents[0].design.screens[0]` for `name`, `screenshot
.downloadUrl`, and `htmlCode.downloadUrl`.
- `tools/list` and every other tool work the same way (same headers, same
  envelope), so any future proxy breakage can be bypassed identically.

Save generated assets under `tmp/stitch/` (gitignored) — screenshots at full
width (`=w1440` desktop, `=w780` mobile) plus the HTML — and show them to the
user before touching app code.
