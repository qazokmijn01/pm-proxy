#!/usr/bin/env node
/**
 * Launcher gọn cho pm-ai-proxy (server tương thích Anthropic → Postman gateway).
 * Xem chi tiết & tham số ở server.mjs và docs/claude-cli-anthropic.md.
 *
 *   node claude-proxy.mjs            # mặc định http://127.0.0.1:8788
 *   PM_ANTHROPIC_PORT=9000 node claude-proxy.mjs
 */
import { startServer } from './server.mjs';
startServer();
