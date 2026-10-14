# Changelog

## 0.1.2

- Also published to [Open VSX](https://open-vsx.org/extension/co3moz/vsc-mcp-inspector) for VSCodium, Cursor, Windsurf and other editors.

## 0.1.1

- Renamed to **MCP Server Inspector** on the Marketplace ("MCP Inspector" is taken by another extension). The activity bar view keeps the short name.
- Extension icon.
- Licensed under MIT.

## 0.1.0

- MCP Inspector view in the activity bar.
- Create, edit, test and delete connections over STDIO, SSE and Streamable HTTP.
- Editable headers and environment variables, with values kept in SecretStorage and `${env:…}` substitution.
- Tree of tools, prompts, resources and resource templates per connection, refreshed on `list_changed`.
- Detail panels with schema-driven forms, a JSON mode, progress, cancellation and rich result rendering.
- JSON-RPC traffic, server logs and stderr in the MCP Inspector output channel.
- ▶ Run action on tree items that opens the panel and invokes the item with its last arguments.
- Connection errors include the underlying cause, with a hint for malformed HTTP responses.
