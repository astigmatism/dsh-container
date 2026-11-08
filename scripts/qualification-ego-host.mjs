/** Loaded ONLY by the disposable plugin-boot fixture, never by a deployment. */
import { randomUUID } from 'node:crypto';
export const inject = ['tools', 'sessions', 'agents', 'webServer', 'connection'];

/**
 * A tool call in the product runs inside a live Agent. Harness 0.2.2 moved result
 * validation and image projection into the shared tool pipeline, which resolves a
 * call against the store's own live Session, so the fixture supplies a real one:
 * the running Agent when the conversation has one, the live Session when a
 * verification created it directly, and a resumed Agent when a restarted server
 * has the session only on disk. A structural stand-in is rejected by the store,
 * so nothing is invented here.
 */
/** Resumed once per session for the life of the disposable server; re-resuming
 *  the same session after disposing it leaves the persistence layer closed. */
const resumed = new Map();

async function callContext(ctx, sessionId) {
  const running = ctx.agents.get(sessionId);
  if (running !== undefined) return { agent: running };
  const session = ctx.sessions.get(sessionId);
  if (session !== undefined) return { agent: { session } };
  let agent = resumed.get(sessionId);
  if (agent === undefined) {
    const handle = await ctx.agents.resume({ resumeSessionId: sessionId });
    agent = handle.agent;
    resumed.set(sessionId, agent);
  }
  return { agent };
}

export function apply(ctx) {
  if (!process.env.DSH_HOME?.includes('/dsh-plugin-boot.')) throw new Error('Qualification requires a disposable home');
  // 0.2.2 made the pipeline's projection private, so the fixture runs the call
  // the way a model step does: one settled call through the batch executor.
  if (typeof ctx.tools.execute !== 'function') throw new Error('Qualification requires the Harness batch tool executor');
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/qualification/ego', handler: async (req, res) => {
    const rejected = ctx.connection.requestRejection(req);
    if (rejected !== undefined) { res.writeHead(rejected); res.end(); return; }
    const abort = new AbortController();
    res.once('close', () => abort.abort());
    try {
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 65536) throw new Error('Fixture request too large'); }
      const { name, args = {}, sessionId, abortAfterMs } = JSON.parse(body);
      if (!name.startsWith('ego_') || !sessionId) throw new Error('Invalid fixture tool call');
      if (!ctx.tools.get(name)) throw new Error(`Tool unavailable: ${name}`);
      const { agent } = await callContext(ctx, sessionId);
      const timer = abortAfterMs ? setTimeout(() => abort.abort(), abortAfterMs) : undefined;
      try {
        const callId = randomUUID();
        const settled = await ctx.tools.execute({
          calls: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }],
          signal: abort.signal,
          agent,
        });
        const outcome = (settled.results.find(entry => entry.callId === callId) ?? settled.results[0])?.result;
        if (outcome === undefined) throw new Error(`Tool produced no result: ${name}`);
        if (outcome.isError) {
          const text = outcome.error?.message ?? outcome.content?.map(block => block.text ?? '').join(' ');
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `${name}: ${text || outcome.error?.code || 'failed'}` }));
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ value: outcome.value, content: outcome.content }));
      } finally {
        clearTimeout(timer);
      }
    } catch (error) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  } }));
}
