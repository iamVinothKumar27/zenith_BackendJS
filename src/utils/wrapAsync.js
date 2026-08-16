// Express 4 does not catch rejected promises thrown by async route handlers/middleware —
// an unhandled rejection there crashes the entire process (e.g. a single transient MongoDB
// DNS blip would take the whole server down for every user). This walks a Router's stack and
// wraps every handler so rejections are routed to next(err) -> the error middleware in app.js,
// instead of escaping as an unhandled rejection.
export function wrapRouterAsync(router) {
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const routeLayer of layer.route.stack) {
      const original = routeLayer.handle;
      routeLayer.handle = function wrapped(req, res, next) {
        try {
          const result = original(req, res, next);
          if (result && typeof result.catch === "function") {
            result.catch(next);
          }
        } catch (err) {
          next(err);
        }
      };
    }
  }
  return router;
}
