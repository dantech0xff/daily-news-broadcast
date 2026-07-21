import worker, { ChannelDeliveryCoordinator } from '../../src/adapters/cloudflare.js';

export { ChannelDeliveryCoordinator };

/**
 * Test entrypoint for the Workers runtime. Production routes are delegated to
 * the real adapter; the sentinel route deliberately attempts one outbound
 * request so the harness can prove it never reaches the network.
 */
export default {
  scheduled(event, env, ctx) {
    return worker.scheduled(event, env, ctx);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/__test/unexpected-outbound') {
      try {
        return await fetch('https://unexpected-outbound.newsengine.invalid/sentinel');
      } catch (error) {
        return new Response(String(error?.message ?? error), {
          status: 599,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    }
    return worker.fetch(request, env, ctx);
  },
};
