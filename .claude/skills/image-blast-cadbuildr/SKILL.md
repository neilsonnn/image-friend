---
name: image-blast-cadbuildr
description: Drive CADBuildr Prototype desktop app via its MCP server and combine CADBuildr geometry with an image-blaster world.
argument-hint: [world-slug] [workspace path or CAD prompt]
allowed-tools: Read Write Bash(node .claude/scripts/cadbuildr/prototype-mcp.mjs *) Bash(node .claude/scripts/project/project-state.mjs *) Bash(ls *)
---

# image-blast-cadbuildr

Use this when the user wants image-blaster to work with CADBuildr Prototype, CADBuildr's MCP server, or CADBuildr-generated geometry.

## Instructions

1. Ensure CADBuildr Prototype desktop app is running and signed in with real model access. Do not use local auth bypass for agent/model behavior checks.
2. Discover the Prototype MCP endpoint using the bridge:

```bash
node .claude/scripts/cadbuildr/prototype-mcp.mjs status
```

If discovery fails, ask the user to start the desktop app or set `CADBUILDR_PROTOTYPE_MCP_URL=http://127.0.0.1:<port>/mcp` from the app Settings page.

3. Inspect the image-blaster world state before sending CAD work:

```bash
node .claude/scripts/project/project-state.mjs --world "<world-slug>"
```

4. Create or reuse a CAD workspace, then open it in Prototype:

```bash
node .claude/scripts/cadbuildr/prototype-mcp.mjs open-workspace "<absolute-workspace-path>"
```

5. Put the requested CAD task in a prompt file inside the workspace. For the chess/table/chair forest demo, the one-shot helper creates the workspace and prompt:

```bash
node .claude/scripts/cadbuildr/prototype-mcp.mjs chess-demo --workspace "$(pwd)/cadbuildr-chess-world-workspace" --world "<world-slug>" --dry-run
```

6. Send the prompt through Prototype's MCP `subagent` tool so the visible desktop app does the CADBuildr work:

```bash
node .claude/scripts/cadbuildr/prototype-mcp.mjs subagent "<workspace>/PROMPT.md" --timeout-s 1800
```

7. Verify output with Prototype MCP tools rather than assuming success:

```bash
node .claude/scripts/cadbuildr/prototype-mcp.mjs run-python-file "<workspace>/cadbuildr_chess_scene.py"
node .claude/scripts/cadbuildr/prototype-mcp.mjs call screenshot '{"target":"viewer","wait_for_paint":true}'
```

8. The desired publishable output should be a static site under the CAD workspace (usually `site/index.html` + `site/assets/*`) that can be copied to or hosted from the CADBuildr chess repo on GitHub Pages. It should load the image-blaster world assets from `worlds/<world-slug>/output/world/` and place CADBuildr-generated chess/table/chair assets into that scene.

## Notes

- The bridge is a thin MCP client. It does not replace CADBuildr Prototype; the desktop app must be running because it owns the CAD runtime, viewer, and MCP server.
- Keep generated CAD files and static-site artifacts out of the git-tracked image-blaster repo unless the user explicitly asks to commit demo outputs. `worlds/*` remains gitignored.
- Prefer local world assets over provider URLs. image-blaster's viewer and GitHub Pages output should load disk-copied assets.
