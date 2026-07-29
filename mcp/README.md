# protoshare-mcp

A local stdio [MCP](https://modelcontextprotocol.io) server that lets Claude Code
pull feedback from, and push versioned updates to, a deployed proto-share
prototype — without leaving your editor. It is a thin client over the deployed
`/api/v1` REST surface; every rule is enforced server-side.

## Setup

1. **Install deps** (once):
   ```bash
   cd mcp && npm install
   ```
2. **Generate an API token** in the proto-share admin UI → *API Tokens* → *Generate*.
   Copy it (shown once).
3. **Create a manifest** in your prototype repo. Copy `.protoshare.example.json`
   to `.protoshare.json` and fill in `remote` and each prototype `id`
   (from `protoshare_list` or the admin URL). The manifest is safe to commit —
   the token is NOT stored in it.
4. **Register with Claude Code** (in your prototype repo):
   ```bash
   claude mcp add protoshare -- env \
     PROTOSHARE_TOKEN=<your-token> \
     PROTOSHARE_MANIFEST=$PWD/.protoshare.json \
     node /absolute/path/to/proto-share/mcp/server.mjs
   ```

## Tools

| Tool | Purpose |
|------|---------|
| `protoshare_list` | List prototypes this token can access |
| `protoshare_pull` | Fetch comments + replies + explanations |
| `protoshare_source` | Download published/specific HTML (writes to the local file) |
| `protoshare_push` | Upload the local file as a draft |
| `protoshare_publish` | Promote a draft to live |
| `protoshare_status` | Local vs remote version summary |

## Environment

| Var | Required | Default | Meaning |
|-----|----------|---------|---------|
| `PROTOSHARE_TOKEN` | yes | — | API token (`id.secret`) from the admin panel |
| `PROTOSHARE_MANIFEST` | no | `./.protoshare.json` | Path to the manifest |

The `remote` base URL comes from the manifest, not the environment.
