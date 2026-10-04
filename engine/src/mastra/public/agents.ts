/**
 * Public API routes for agent management.
 * Mounted at /api/agents on the engine's HTTP server.
 */

import { createAgentApiHandlers } from '../lib/agent-api.ts';
import { readyPaths } from '../lib/home.ts';

const handlers = createAgentApiHandlers(readyPaths());

export default {
  'GET /api/agents': () => {
    try {
      return { ok: true, data: handlers.listAgents() };
    } catch (e) {
      return { ok: false, error: String(e), status: 500 };
    }
  },

  'GET /api/agents/:id': (req: { params: { id: string } }) => {
    try {
      return { ok: true, data: handlers.getAgent(req.params.id) };
    } catch (e) {
      return { ok: false, error: String(e), status: e instanceof Error && e.message.includes('not found') ? 404 : 500 };
    }
  },

  'PUT /api/agents/:id/config': (req: { params: { id: string }; body: unknown }) => {
    try {
      const config = req.body as Record<string, unknown>;
      return { ok: true, data: handlers.updateAgentConfig(req.params.id, config) };
    } catch (e) {
      return { ok: false, error: String(e), status: 400 };
    }
  },

  'DELETE /api/agents/:id': (req: { params: { id: string } }) => {
    try {
      handlers.deleteAgent(req.params.id);
      return { ok: true, data: { deleted: req.params.id } };
    } catch (e) {
      return { ok: false, error: String(e), status: e instanceof Error && e.message.includes('not found') ? 404 : 500 };
    }
  },

  'POST /api/agents': (req: { body: { id: string; name: string; role: string } }) => {
    try {
      const { id, name, role } = req.body;
      return { ok: true, data: handlers.createAgent(id, name, role) };
    } catch (e) {
      return { ok: false, error: String(e), status: 400 };
    }
  },
};
