# MCP configuration
Propose a `servers` array (1–20), e.g.:
{"servers":[{"name":"Documentation","transport":"http","command":"","args":[],"url":"https://mcp.example.com/mcp"}]}

For stdio use transport `stdio`, an executable command and a string args array, with an empty url. Absolute executable paths work directly; a program name is saved disabled with a reminder to configure an absolute path. Shell command strings are not executed by this workflow. For HTTP, use an HTTPS URL (no embedded username/password or credential query parameters).

A local JSON file may contain one such configuration or {"mcpServers":{"name":{"command":"/absolute/program","args":[]}}}. `type: "streamable-http"` is accepted as HTTP. Unknown fields, env, headers, auth, OAuth objects and literal secrets are rejected before model access. Remove credential values from the source and enter them through the installed MCP configuration later. New same-name standalone servers are refused rather than silently overwritten.
