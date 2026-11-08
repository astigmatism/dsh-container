/** Loaded ONLY by the disposable plugin-boot fixture, never by a deployment. */
import { randomUUID } from 'node:crypto';
export const inject = ['tools', 'sessions', 'webServer', 'connection'];
export function apply(ctx) {
  if (!process.env.DSH_HOME?.includes('/dsh-plugin-boot.')) throw new Error('Qualification requires a disposable home');
  // Harness 0.2.2 made result validation and projection a private step of the
  // shared tool pipeline, so the fixture runs the call the way a model step
  // does: one settled call through the batch executor, without a Session log.
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
      // The pipeline resolves a call against the store's own live Session, so
      // the fixture passes that object rather than a structural stand-in.
      const session = ctx.sessions.get(sessionId);
      if (session === undefined) throw new Error(`Session unavailable: ${sessionId}`);
      const timer = abortAfterMs ? setTimeout(() => abort.abort(), abortAfterMs) : undefined;
      try {
        const callId = randomUUID();
        const settled = await ctx.tools.execute({
          calls: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }],
          signal: abort.signal,
          // Ego reads the calling session structurally off the agent; a batch
          // without a Session log writes no events, so nothing else is needed.
          agent: { session },
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
      } finally { clearTimeout(timer); }
    } catch (error) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  } }));
}
