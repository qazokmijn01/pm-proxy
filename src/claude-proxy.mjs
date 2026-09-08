#!/usr/bin/env node
/**
 * Launcher gon cho pm-ai-proxy (server tuong thich Anthropic -> Postman gateway).
 * Xem chi tiet & tham so o server.mjs va docs/claude-cli-anthropic.md.
 *
 *   node src/claude-proxy.mjs            # mac dinh http://127.0.0.1:8788
 *   PM_ANTHROPIC_PORT=9000 node src/claude-proxy.mjs
 */
import { startServer } from './server.mjs';
startServer();
