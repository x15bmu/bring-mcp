# MCP Server for Bring! Shopping

![bring-mcp](./assets/header.jpg)

This project implements a local Model Context Protocol (MCP) server in TypeScript that exposes the functionalities of the Bring! shopping list API. It enables applications like Claude Desktop to interact with your Bring! shopping lists using standardized MCP tools.

The server integrates the `bring-shopping` npm package for Bring! API access and uses the MCP TypeScript SDK v2 server package to provide an MCP-compliant interface.

> **Disclaimer:**  
> This is a personal project. I am not affiliated with Bring! Labs AG in any way.  
> This project uses an **unofficial Bring! API**, which may change or be blocked at any time.  
> This could cause the MCP server to stop functioning without prior notice.

---

## 🧩 Recommended Claude Desktop Configuration

To use this server in Claude Desktop via `npx`, insert the following into your `claude_desktop_config.json` file:

```json
{
  "mcpServers": {
    "bring-mcp": {
      "command": "npx",
      "args": ["-y", "bring-mcp@latest"],
      "env": {
        "BRING_EMAIL": "your_bring_email@example.com",
        "BRING_PASSWORD": "YOUR_BRING_PASSWORD_HERE"
      }
    }
  }
}
```

This is the recommended and most portable configuration. It ensures you always use the latest version published to npm without needing local installation.

---

## 💬 Using with ChatGPT via OpenAI Secure MCP Tunnel

[OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) lets ChatGPT reach this STDIO server without exposing it through a public endpoint. The tunnel client itself is provided as a downloadable binary, while `bring-mcp` can still be launched through `npx` without a local checkout or installation.

### Prerequisites

- Node.js 22 or newer, including `npm`/`npx`
- ChatGPT developer-mode access
- `Tunnels Read + Use` permissions in the relevant OpenAI Platform organization
- A tunnel ID and runtime API key from [OpenAI Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels)
- The `tunnel-client` binary, available from the download link in the tunnel settings

When creating the tunnel, associate it with the ChatGPT workspace in which you want to use Bring. Otherwise, it will not appear when creating the ChatGPT connection.

### Configure and run the tunnel

Export the tunnel API key and your Bring! credentials in the shell that will run `tunnel-client`:

```bash
export CONTROL_PLANE_API_KEY="sk-..."
export BRING_EMAIL="your_bring_email@example.com"
export BRING_PASSWORD="YOUR_BRING_PASSWORD_HERE"
```

Create a tunnel profile that starts the latest published `bring-mcp` package through `npx`:

```bash
tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile bring-mcp \
  --tunnel-id tunnel_0123456789abcdef0123456789abcdef \
  --mcp-command "npx -y bring-mcp@latest"
```

Validate the configuration, then start the tunnel:

```bash
tunnel-client doctor --profile bring-mcp --explain
tunnel-client run --profile bring-mcp
```

Keep this process running while using the integration. The environment variables above are inherited by the `npx`-started MCP server.

### Connect the tunnel in ChatGPT

1. In ChatGPT, open **Settings → Security and login** and enable **Developer mode**.
2. Open [ChatGPT Plugins](https://chatgpt.com/plugins) and select the plus button to create a developer-mode app.
3. Enter a name and description, choose **Tunnel** under **Connection**, and select the tunnel created above (or enter its `tunnel_id`).
4. Create the connection and review the 16 discovered Bring! tools.
5. Start a new chat, enable the Bring connection from the tools menu, and try a request such as “Show my Bring shopping lists.”

If ChatGPT cannot discover the server, make sure `tunnel-client run` is still active, rerun the `doctor` command, and verify that the tunnel is associated with the correct ChatGPT workspace. Secure MCP Tunnel is intended for private connections and developer-mode testing; publishing a public ChatGPT plugin requires a stable public HTTPS MCP endpoint.

---

## 🚀 Features

- **Automatic Authentication**: No manual login required - authentication happens automatically on first API call
- Exposes Bring! API functions as MCP tools:
  - 🧾 Load shopping lists
  - 🛒 Get and modify items (add, remove, move)
  - 📦 Batch operations (save multiple items, delete multiple items)
  - 🖼 Save/remove item images
  - 👥 Manage list users
  - 🎯 Get default shopping list UUID
  - 🌐 Load translations & catalog
  - 📨 Retrieve pending invitations
- Communicates via STDIO (for use with Claude Desktop or MCP Inspector)
- Supports MCP protocol revision `2026-07-28` while continuing to serve legacy 2025 clients
- Publishes tool titles, annotations, concrete input/output schemas, and machine-readable structured results
- Marks tool failures with `isError: true` so clients can distinguish them from successful calls
- Supports Bring! credentials via `.env` file or injected environment variables

### Available Tools

- **`loadLists`**: Load all shopping lists from Bring!
- **`getItems`**: Get all items from a specific shopping list
- **`getItemsDetails`**: Get details for items in a list
- **`saveItem`**: Save an item to a shopping list with optional specification
- **`saveItemBatch`**: Save multiple items to a shopping list in one operation
- **`removeItem`**: Remove an item from a specific shopping list
- **`moveToRecentList`**: Move an item to the recently used items list
- **`deleteMultipleItemsFromList`**: Delete multiple items from a list by their names
- **`saveItemImage`**: Save an item image from base64-encoded image data (maximum decoded size: 5 MiB)
- **`removeItemImage`**: Remove an image from an item
- **`getAllUsersFromList`**: Get all users associated with a shopping list
- **`getUserSettings`**: Get settings for the authenticated user
- **`getDefaultList`**: Get the UUID of the default shopping list (use when user doesn't specify a list)
- **`loadTranslations`**: Load translations for the Bring! interface
- **`loadCatalog`**: Load the Bring! item catalog
- **`getPendingInvitations`**: Get pending invitations to join shopping lists

---

## ⚙️ Setup and Installation

1. **Clone the repo (or obtain the files)**

2. **Navigate into the project directory:**

   ```bash
   cd path/to/bring-mcp
   ```

3. **Install dependencies:**

   ```bash
   npm install
   ```

4. **Create `.env` file (if not injecting ENV directly):**

   ```env
   BRING_EMAIL=your_email@example.com
   BRING_PASSWORD=your_password
   ```

5. **Build the project:**

   ```bash
   npm run build
   ```

6. **Make script executable (optional on Unix):**

   ```bash
   chmod +x build/src/index.js
   ```

---

## 🏃 Running the Server

Launch the MCP server with:

```bash
node build/src/index.js
```

If successful, you'll see: `MCP server for Bring! API v<version> is running on STDIO` (on `stderr`).

---

## 🧪 Testing with MCP Inspector

1. Ensure `npm run build` has been executed.
2. Ensure `.env` with valid credentials exists.
3. Run Inspector:

   ```bash
   npx @modelcontextprotocol/inspector node /ABS/PATH/bring-mcp/build/src/index.js
   ```

---

## 🧩 Claude Desktop Integration (Manual Local Setup)

Alternatively, if you prefer a locally built and installed version:

```json
{
  "mcpServers": {
    "mcp-bring": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/bring-mcp/build/src/index.js"],
      "env": {
        "BRING_EMAIL": "your_bring_email@example.com",
        "BRING_PASSWORD": "YOUR_BRING_PASSWORD_HERE"
      }
    }
  }
}
```

---

## 🔧 Development

### Testing

Run tests with:

```bash
npm run test
```

This command runs formatting, linting, and Jest tests with coverage reporting.

For CI testing:

```bash
npm run test:ci
```

### Building

Build the project:

```bash
npm run build
```

### Key Dependencies and Tools

- `@modelcontextprotocol/server`: MCP SDK v2 server and STDIO protocol dispatcher
- `@modelcontextprotocol/client`: Development-only client used for end-to-end protocol compatibility tests
- `@modelcontextprotocol/inspector`: Run on demand with `npx` for testing and debugging MCP servers
- `bring-shopping`: Node.js wrapper for the Bring! API
- `zod`: For schema definition and validation
- `dotenv`: For managing environment variables

---

## ✅ Final Notes

- 🔒 Avoid committing your `.env` file.
- ♻️ `MAIL` and `PW` remain supported as deprecated aliases for existing installations.
- 🧼 Keep credentials out of version control.
- 🛠 MCP Inspector is invaluable for debugging.
- 🔄 Authentication is handled automatically - no manual login required.
- 📦 Use batch operations for efficiency when working with multiple items.

Happy coding with MCP and Bring! 🎉

## Deploy to AWS Lambda (remote MCP for ChatGPT / Claude)

The Lambda build serves the same tools over **Streamable HTTP** (stateless, JSON responses) behind a Lambda Function URL.
Because ChatGPT and Claude require OAuth for remote MCP servers, the Lambda includes a small, database-free OAuth 2.1
authorization server (PKCE S256, dynamic client registration, RFC 8707 `resource`, RFC 9207 `iss`). Authorization is a
single **passphrase** page; codes and tokens are signed JWTs.

### 1. Bring! account

Bring! has no OAuth, and accounts created via "Sign in with Google" have no password. Create a **second Bring! account**
with an email and password, then invite it to the lists you want to expose from your main account. The Lambda signs in as
that account. Only lists shared with it are reachable.

### 2. Secret

Create a Secrets Manager secret (default name `bring-mcp/config`) with JSON like:

```json
{
  "BRING_EMAIL": "second-account@example.com",
  "BRING_PASSWORD": "its-password",
  "AUTH_PASSPHRASE": "at least 12 chars - use 20+ random characters",
  "JWT_SECRET": "at least 32 random characters"
}
```

Generate the last two with e.g. `openssl rand -base64 32`.

### 3. Build and deploy

```bash
npm ci
npm run build:lambda
sam deploy --guided
```

The stack outputs `McpUrl` (the Function URL plus `/mcp`). The issuer is detected from the request host, so no second
deploy is needed. Set `PublicBaseUrl` only if you front the function with a custom domain.

### 4. Connect a client

- **Claude**: Settings -> Connectors -> Add custom connector -> paste `McpUrl`.
- **ChatGPT**: add a custom connector / app with the `McpUrl`, authentication OAuth.
- **Claude Code**: `claude mcp add --transport http bring <McpUrl>`

When prompted, enter your `AUTH_PASSPHRASE` on the consent page.

### Security notes

- Anyone who knows the passphrase acts as the shared Bring! account. Use a long random one.
- Tokens cannot be revoked individually; rotate `JWT_SECRET` in Secrets Manager (and redeploy or wait for a cold start)
  to revoke all of them. Access tokens last 1 hour, refresh tokens 14 days.
- Wrong passphrase guesses are delayed by 1 second. Set up an AWS budget alert (and optionally `ReservedConcurrentExecutions` if your AWS account quota allows it) to cap parallel invocations.
- Redirect URIs are restricted to an allow-list (`RedirectUriAllowlist` parameter; defaults cover claude.ai, claude.com,
  chatgpt.com, Google/Gemini relay domains, and loopback addresses for local clients).
- Do not log tokens or secrets; this code never does.
