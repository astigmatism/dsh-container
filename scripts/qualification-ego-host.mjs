/** Loaded ONLY by the disposable plugin-boot fixture, never by a deployment. */
import { randomUUID } from 'node:crypto';
export const inject = ['tools', 'webServer', 'connection'];
export function apply(ctx) {
  if (!process.env.DSH_HOME?.includes('/dsh-plugin-boot.')) throw new Error('Qualification requires a disposable home');
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/qualification/ego', handler: async (req, res) => {
    const rejected = ctx.connection.requestRejection(req);
    if (rejected !== undefined) { res.writeHead(rejected); res.end(); return; }
    const abort = new AbortController();
    res.once('close', () => abort.abort());
    try {
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 65536) throw new Error('Fixture request too large'); }
      const { name, args = {}, sessionId, abortAfterMs } = JSON.parse(body);
      if (!name.startsWith('ego_') || !sessionId) throw new Error('Invalid fixture tool call');
      const tool = ctx.tools.get(name);
      if (!tool) throw new Error(`Tool unavailable: ${name}`);
      const timer = abortAfterMs ? setTimeout(() => abort.abort(), abortAfterMs) : undefined;
      try {
        const execution = { callId: randomUUID(), name, arguments: args, token: {}, agent: { session: { id: sessionId } }, signal: abort.signal };
        const value = await tool.execute(args, execution);
        // Exercise the installed Harness value validation and image projection,
        // not only the plugin's renderer. No fixture code is shipped in a profile.
        const result = ctx.tools.createSuccessResult(execution, tool, value);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ value: result.value, content: result.content }));
      } finally { clearTimeout(timer); }
    } catch (error) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  } }));
}
