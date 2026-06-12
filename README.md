<img width="960" height="540" alt="image-blaster-1" src="https://github.com/user-attachments/assets/d294e420-eb48-4f00-b6a8-13005442d1a8" />

## `image-blaster`
Creates 3D environments, SFX, and meshes from a single image using Claude skills, World Labs, and FAL. 

Can take you from an image to a fully meshed 3D environment in < 5 minutes, great for jumpstarting 3D work. Go full blast.


## Quickstart

1. Open a Terminal, enter `git clone https://github.com/neilsonnn/image-blaster`
2. Enter the directory with `cd image-blaster`
3. Run `claude` (install with `curl -fsSL https://claude.ai/install.sh | bash`)
4. Say hello to Claude, and give them your API key for [World Labs](https://platform.worldlabs.ai/) and [FAL](https://fal.ai/).
5. Put an image into `input/` directory and ask Claude to `blast it and confirm each step with me`.

### Description

By default `image-blaster` will use your input image to create:

1. 3D models (`.glb`, `.obj`) of all *dynamic* objects
2. Gaussian splat (`.spz`) of the *static* environment,
3. Ambient looping sound and object specific physics SFX (`.mp3`)

### Extensions

You can embed `image-blaster` under the assets of *any game engine, DCC software, or web app*.

1. Unity, Unreal, or Godot game engine
2. Blender, 3DS Max, or Maya or other DCC software
3. Three.js web app or Electron app
4. CADBuildr Prototype desktop app via its streamable-HTTP MCP server

### CADBuildr Prototype MCP bridge

This fork includes a CADBuildr bridge so an image-blaster world can become the
backdrop for CADBuildr-generated geometry. The bridge talks to the running
CADBuildr Prototype desktop app MCP server; it does not fake the CAD runtime.

1. Start CADBuildr Prototype and sign in.
2. In Prototype Settings, copy the MCP URL or let the bridge discover the
   `prototype-mcp.json` file written by the app.
3. From this repo, verify connectivity:

```sh
node .claude/scripts/cadbuildr/prototype-mcp.mjs status
node .claude/scripts/cadbuildr/prototype-mcp.mjs tools
```

If discovery is not automatic, set:

```sh
export CADBUILDR_PROTOTYPE_MCP_URL="http://127.0.0.1:<port>/mcp"
```

To scaffold and run the chess/table/chair demo prompt against a generated
image-blaster world:

```sh
node .claude/scripts/cadbuildr/prototype-mcp.mjs chess-demo \
  --workspace "$(pwd)/cadbuildr-chess-world-workspace" \
  --world "forest-chess-world"
```

Use `--dry-run` to only create the workspace and `PROMPT.md` without calling the
MCP server. The intended output is a static `site/` folder with a GitHub
Pages-ready web scene that loads the image-blaster world and places CADBuildr
chess/table/chair assets in it.

## Advanced

IMAGE-BLASTER uses a few generation models:

- `marble-1.1` - World Labs Marble model creates the explorable environment.
- `nano-banana` - default image edit preference for source cleanup, clean plates, and object reference images.
- `gpt-image-2` - alternate image edit provider when the edit skill is asked to prefer it.
- `hunyuan-3d` - Hunyuan 3D model creates 3D object models through FAL.
- `elevenlabs-sfx` - ElevenLabs sound effects model creates ambient and object-specific sounds.

3D model creation supports these Hunyuan parameters:

- `--face-count <40000-1500000>`: target face count. IMAGE-BLASTER defaults to `50000`; Hunyuan's API default is `500000`.
- `--enable-pbr true|false`: enable PBR material generation. Defaults to `true`.
- `--generate-type Normal|LowPoly|Geometry`: `Normal` creates a textured model, `LowPoly` applies polygon reduction, and `Geometry` creates a white geometry-only model. Defaults to `Normal`.
- `--polygon-type triangle|quadrilateral`: polygon type for `LowPoly`. Defaults to `triangle`.

### Examples

- Video game level concepts? `IMAGE-BLAST` it.
- Your childhood bedroom? `IMAGE-BLAST` it.
- Need an environment for a robot? `IMAGE-BLAST` it.
- A film location scout? `IMAGE-BLAST` it.
- An architectural rendering? `IMAGE-BLAST` it.

### Development

- remove `/app` from the `.claudeignore` file to give Claude the ability to change the React viewer.
